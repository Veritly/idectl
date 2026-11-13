"""LLDB source stepping that finishes outside Rust dependency frames."""

import lldb

plans = []


def finish(debugger):
    process = debugger.GetSelectedTarget().GetProcess()
    active = [plan for plan in plans if plan.IsValid()
              and plan.GetThread().GetProcess().GetUniqueID() == process.GetUniqueID()]
    indexes = {plan.GetThread().GetIndexID() for plan in active}
    for thread in process:
        if thread.GetIndexID() not in indexes:
            continue
        result = lldb.SBCommandReturnObject()
        debugger.GetCommandInterpreter().HandleCommand(
            "thread plan discard 1", lldb.SBExecutionContext(thread), result
        )
        if not result.Succeeded():
            raise RuntimeError(result.GetError())
    plans[:] = [plan for plan in plans if plan.IsValid()
                and plan.GetThread().GetProcess().GetUniqueID() != process.GetUniqueID()]


def step(debugger, index, plan):
    if plan not in ("Into", "Over", "Out"):
        raise ValueError("Expected Into, Over or Out")
    process = debugger.GetSelectedTarget().GetProcess()
    thread = process.GetThreadByIndexID(index)
    if process.GetState() != lldb.eStateStopped or not thread.IsValid():
        raise ValueError("The selected IDE thread is not available in a stopped process")
    finish(debugger)
    result = lldb.SBCommandReturnObject()
    debugger.GetCommandInterpreter().HandleCommand(
        f"thread step-scripted -C veritly_step.{plan} -m all-threads {thread.GetIndexID()}", result
    )
    if not result.Succeeded():
        raise RuntimeError(result.GetError())


class Over:
    enter = False

    def __init__(self, plan, _):
        self.plan = plan
        plans.append(plan)
        frame = plan.GetThread().GetFrameAtIndex(0)
        line = frame.GetLineEntry()
        start = line.GetStartAddress()
        size = line.GetEndAddress().GetFileAddress() - start.GetFileAddress()
        if not line.IsValid():
            self.child = plan.QueueThreadPlanForStepOut(0)
            return
        if line.GetLine() == 0 or size <= 0:
            self.child = self.advance()
            return
        self.child = self.queue(start, size)

    def advance(self):
        # Async spills can have line zero inside the current workspace function.
        # Leaving that frame would silently run past the call being stepped into.
        error = lldb.SBError()
        child = self.plan.QueueThreadPlanForStepSingleInstruction(not self.enter, error)
        if not error.Success():
            raise RuntimeError(str(error))
        return child

    def queue(self, start, size):
        return self.plan.QueueThreadPlanForStepOverRange(start, size)

    def explains_stop(self, event):
        reason = self.plan.GetThread().GetStopReason()
        if reason in (
            lldb.eStopReasonBreakpoint, lldb.eStopReasonWatchpoint,
            lldb.eStopReasonSignal, lldb.eStopReasonException,
        ):
            # Preserve the user's stop, but do not resume an interrupted step later.
            self.plan.SetPlanComplete(True)
            return False
        return self.child.IsPlanComplete()

    def should_stop(self, event):
        if not self.child.IsPlanComplete():
            return False
        frame = self.plan.GetThread().GetFrameAtIndex(0)
        line = frame.GetLineEntry()
        file = str(line.GetFileSpec()).replace("\\", "/")
        library = any(part in file for part in (
            "/rustc/", "/stdlib-local-copy/", "/lib/rustlib/src/rust/library/",
            "/registry/src/", "/git/checkouts/",
        ))
        if frame.IsValid() and (not line.IsValid() or library):
            self.child = self.plan.QueueThreadPlanForStepOut(0)
            return False
        if frame.IsValid() and line.GetLine() == 0:
            self.child = self.advance()
            return False
        self.plan.SetPlanComplete(True)
        return True

    def should_step(self):
        return False

    def stop_description(self, stream):
        stream.Print("Workspace source step completed")


class Out(Over):
    def __init__(self, plan, _):
        self.plan = plan
        plans.append(plan)
        self.child = plan.QueueThreadPlanForStepOut(0)


class Into(Over):
    enter = True

    def queue(self, start, size):
        return self.plan.QueueThreadPlanForStepInRange(start, size)
