"""LLDB source stepping that finishes outside Rust dependency frames."""


class Over:
    def __init__(self, plan, _):
        self.plan = plan
        frame = plan.GetThread().GetFrameAtIndex(0)
        line = frame.GetLineEntry()
        start = line.GetStartAddress()
        size = line.GetEndAddress().GetFileAddress() - start.GetFileAddress()
        if not line.IsValid() or size <= 0:
            raise ValueError("Source step-over requires a valid source line range")
        self.child = plan.QueueThreadPlanForStepOverRange(start, size)

    def explains_stop(self, event):
        # Breakpoints, signals and exceptions remain visible to the user.
        return False

    def should_stop(self, event):
        if not self.child.IsPlanComplete():
            return False
        frame = self.plan.GetThread().GetFrameAtIndex(0)
        file = str(frame.GetLineEntry().GetFileSpec()).replace("\\", "/")
        library = any(part in file for part in (
            "/rustc/", "/stdlib-local-copy/", "/lib/rustlib/src/rust/library/",
            "/registry/src/", "/git/checkouts/",
        ))
        if library:
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
