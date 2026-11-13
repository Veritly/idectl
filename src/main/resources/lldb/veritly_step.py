"""LLDB source stepping that finishes outside Rust dependency frames."""

import lldb


def step(debugger, index, plan):
    if plan not in ("Into", "Over", "Out"):
        raise ValueError("Expected Into, Over or Out")
    process = debugger.GetSelectedTarget().GetProcess()
    thread = process.GetThreadByIndexID(index)
    if process.GetState() != lldb.eStateStopped or not thread.IsValid():
        raise ValueError("The selected IDE thread is not available in a stopped process")
    result = lldb.SBCommandReturnObject()
    debugger.GetCommandInterpreter().HandleCommand(
        f"thread step-scripted -C veritly_step.{plan} -m all-threads {thread.GetIndexID()}", result
    )
    if not result.Succeeded():
        raise RuntimeError(result.GetError())


class Over:
    def __init__(self, plan, _):
        self.plan = plan
        frame = plan.GetThread().GetFrameAtIndex(0)
        line = frame.GetLineEntry()
        start = line.GetStartAddress()
        size = line.GetEndAddress().GetFileAddress() - start.GetFileAddress()
        if not line.IsValid() or line.GetLine() == 0 or size <= 0:
            self.child = plan.QueueThreadPlanForStepOut(0)
            return
        self.child = self.queue(start, size)

    def queue(self, start, size):
        return self.plan.QueueThreadPlanForStepOverRange(start, size)

    def explains_stop(self, event):
        # Breakpoints, signals and exceptions remain visible to the user.
        return False

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
        if frame.IsValid() and (not line.IsValid() or line.GetLine() == 0 or library):
            self.child = self.plan.QueueThreadPlanForStepOut(0)
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
        self.child = plan.QueueThreadPlanForStepOut(0)


class Into(Over):
    def queue(self, start, size):
        return self.plan.QueueThreadPlanForStepInRange(start, size)
