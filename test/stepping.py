"""Run with python3 test/stepping.py /path/to/IDE/bin/lldb/linux/x64/bin/lldb."""

import pathlib
import subprocess
import sys
import tempfile

SOURCE = '''use std::{future::{Future, ready}, pin::Pin, task::{Context, Waker}};
#[inline(never)]
fn add(value: u32) -> u32 {
    value + 1
}
#[inline(never)]
async fn load() -> u32 {
    let value = ready(41).await;
    add(std::hint::black_box(value)) // pause
}
#[inline(never)]
async fn wrap() -> u32 {
    let future: Pin<Box<dyn Future<Output = u32>>> = Box::pin(load());
    future.await
}
fn main() {
    let worker = std::thread::spawn(|| {
    let mut future = Box::pin(wrap());
    let mut context = Context::from_waker(Waker::noop());
    let result = future.as_mut().poll(&mut context);
    let _ = std::hint::black_box(result); // interrupt
    });
    worker.join().unwrap();
}
'''


def run(debugger, exe, source):
    import lldb

    debugger.SetAsync(False)
    target = debugger.CreateTarget(exe)
    pause = target.BreakpointCreateByLocation(source, next(i for i, line in enumerate(SOURCE.splitlines(), 1) if "// pause" in line))
    assert pause.GetNumLocations() > 0

    def launch():
        process = target.LaunchSimple(None, None, str(pathlib.Path(exe).parent))
        assert process.GetState() == lldb.eStateStopped
        thread = process.GetSelectedThread()
        assert thread.GetStopReason() == lldb.eStopReasonBreakpoint
        return process, thread

    process, thread = launch()
    library = False
    for _ in range(5):
        thread.StepOver()
        if 'future.rs' in str(thread.GetFrameAtIndex(0).GetLineEntry().GetFileSpec()):
            library = True
            break
    assert library, 'fixture must reproduce the native dependency-frame stop'
    process.Kill()

    process, thread = launch()
    import veritly_step
    others = [row for row in process if row.GetThreadID() != thread.GetThreadID()]
    assert others, 'fixture needs an unrelated waiting thread'
    assert thread.GetThreadID() != thread.GetIndexID(), 'fixture must distinguish OS IDs from debugger indexes'
    process.SetSelectedThread(others[0])
    for _ in range(5):
        veritly_step.step(debugger, thread.GetIndexID(), 'Into')
        assert process.GetSelectedThread().GetThreadID() == thread.GetThreadID()
        frame = thread.GetFrameAtIndex(0)
        assert str(frame.GetLineEntry().GetFileSpec()) == source
        assert frame.GetLineEntry().GetLine() > 0
        if 'add' in frame.GetFunctionName():
            break
    else:
        raise AssertionError('step-into skipped the workspace helper after its library argument')
    process.Continue()
    assert process.GetState() == lldb.eStateExited, 'a completed step must not pause again on resume'

    for action in ('Into', 'Over'):
        process, thread = launch()
        frame = thread.GetFrameAtIndex(0)
        address = next(ins.GetAddress() for ins in frame.GetFunction().GetInstructions(target)
                       if ins.GetAddress().GetLoadAddress(target) > frame.GetPC()
                       and ins.GetAddress().GetLineEntry().IsValid()
                       and ins.GetAddress().GetLineEntry().GetLine() == 0)
        zero = target.BreakpointCreateByAddress(address.GetLoadAddress(target))
        pause.SetEnabled(False)
        process.Continue()
        assert thread.GetStopReasonDataAtIndex(0) == zero.GetID()
        assert thread.GetFrameAtIndex(0).GetLineEntry().GetLine() == 0
        zero.SetEnabled(False)
        for _ in range(5):
            veritly_step.step(debugger, thread.GetIndexID(), action)
            frame = thread.GetFrameAtIndex(0)
            assert frame.GetLineEntry().GetLine() > 0
            assert 'load' in frame.GetFunctionName() or 'add' in frame.GetFunctionName(), 'line-zero stepping left the async function'
            if action == 'Over' or 'add' in frame.GetFunctionName():
                break
        else:
            raise AssertionError('line-zero step-into skipped the workspace helper')
        process.Kill()
        target.BreakpointDelete(zero.GetID())
        pause.SetEnabled(True)

    process, thread = launch()
    thread.StepOut()
    assert 'future.rs' in str(thread.GetFrameAtIndex(0).GetLineEntry().GetFileSpec())
    process.Kill()

    process, thread = launch()
    error = thread.StepUsingScriptedThreadPlan('veritly_step.Out')
    assert error.Success(), str(error)
    assert str(thread.GetFrameAtIndex(0).GetLineEntry().GetFileSpec()) == source
    assert 'wrap' in thread.GetFrameAtIndex(0).GetFunctionName()
    process.Kill()

    interrupt = target.BreakpointCreateByLocation(source, next(i for i, line in enumerate(SOURCE.splitlines(), 1) if "// interrupt" in line))
    assert interrupt.GetNumLocations() > 0
    process, thread = launch()
    pause.SetEnabled(False)
    for _ in range(5):
        error = thread.StepUsingScriptedThreadPlan('veritly_step.Over')
        assert error.Success(), str(error)
        file = str(thread.GetFrameAtIndex(0).GetLineEntry().GetFileSpec())
        assert not any(part in file for part in ('/rustc/', '/lib/rustlib/', '/registry/src/')), file
        assert thread.GetFrameAtIndex(0).GetLineEntry().GetLine() > 0
        if thread.GetStopReason() == lldb.eStopReasonBreakpoint:
            assert thread.GetStopReasonDataAtIndex(0) == interrupt.GetID()
            break
    else:
        raise AssertionError('workspace breakpoint did not interrupt the step')
    interrupt.SetEnabled(False)
    veritly_step.finish(debugger)
    process.Continue()
    assert process.GetState() == lldb.eStateExited, (process.GetState(), thread.GetStopReason(), str(thread.GetFrameAtIndex(0)))
    assert process.GetExitStatus() == 0
    print('PASS: async dependency frames skipped and user breakpoint preserved')


if __name__ == '__main__':
    root = pathlib.Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix='veritly-step-') as folder:
        source = pathlib.Path(folder) / 'fixture.rs'
        source.write_text(SOURCE)
        exe = pathlib.Path(folder) / 'fixture'
        subprocess.run(['rustc', '--edition=2024', '-g', str(source), '-o', str(exe)], check=True)
        result = subprocess.run([
            sys.argv[1], '--batch',
            '-o', f'command script import "{root}/src/main/resources/lldb/veritly_step.py"',
            '-o', f'command script import "{pathlib.Path(__file__).resolve()}"',
            '-o', f'script stepping.run(lldb.debugger, {str(exe)!r}, {str(source)!r})',
        ], capture_output=True, text=True, timeout=10)
        print(result.stdout)
        print(result.stderr, file=sys.stderr)
        if result.returncode or 'PASS: async dependency frames skipped' not in result.stdout:
            sys.exit(1)
