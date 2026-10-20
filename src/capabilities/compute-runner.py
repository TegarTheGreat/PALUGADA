"""What `code.compute` runs inside its container (src/capabilities/compute.ts).

Handed to `python3 -I -c` with each call rather than built into the image, so
the image need only be Python with the libraries a company's figures want,
and the protocol cannot drift from the server that speaks it.

One JSON request on stdin: the role's code, the files it named, and its time.
The files are written under `in/`, the code is run as `main.py` in a process
of its own -- its own session, so the whole group ends at its time -- with
what it prints going to files rather than a pipe, so printing without end
fills the container's scratch and stops there rather than in this process's
memory. Then what the code left in `out/` is listed and, when every entry is
a plain file within the limits, handed back. One JSON answer on stdout.

What is handed back is not trusted by the server, which checks every name
and limit again: code that ran as the same user could have replaced any of
this, and all it could then hand back is what it could have written to
`out/` itself.
"""
import base64
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile


def collect(out, max_files, max_bytes):
    """The files under `out/`, or the reason none are kept."""
    # `out` itself made a link would be walked through.
    if os.path.islink(out):
        return None, {'why': 'link', 'path': '.'}
    found = []
    total = 0
    for directory, folders, names in os.walk(out):
        folders.sort()
        for folder in folders:
            if os.path.islink(os.path.join(directory, folder)):
                return None, {'why': 'link', 'path': os.path.relpath(os.path.join(directory, folder), out)}
        for name in sorted(names):
            full = os.path.join(directory, name)
            relative = os.path.relpath(full, out)
            if os.path.islink(full):
                return None, {'why': 'link', 'path': relative}
            if not os.path.isfile(full):
                return None, {'why': 'not-file', 'path': relative}
            found.append((relative, full))
            if len(found) > max_files:
                return None, {'why': 'too-many'}
            total += os.path.getsize(full)
            if total > max_bytes:
                return None, {'why': 'too-large'}
    files = []
    for relative, full in found:
        with open(full, 'rb') as handle:
            files.append({'path': relative, 'data': base64.b64encode(handle.read()).decode('ascii')})
    return files, None


def printed(handle, limit):
    """What the code printed, its first `limit` bytes, and how many more there were.

    Read through the handle it was printed to, not by its name, which the
    code could have pointed somewhere else.
    """
    size = os.fstat(handle.fileno()).st_size
    handle.seek(0)
    head = handle.read(limit)
    return head.decode('utf-8', errors='replace'), max(0, size - limit)


def main():
    request = json.loads(sys.stdin.buffer.read())
    seconds = int(request['seconds'])
    # The whole runner ends, whatever below it hangs: the default action of
    # SIGALRM ends the process, and with it the container.
    signal.alarm(seconds + 20)

    base = tempfile.mkdtemp(prefix='compute-')
    try:
        work = os.path.join(base, 'work')
        os.makedirs(os.path.join(work, 'in'))
        os.makedirs(os.path.join(work, 'out'))
        for item in request['files']:
            target = os.path.normpath(os.path.join(work, 'in', item['path']))
            if not target.startswith(os.path.join(work, 'in') + os.sep):
                raise ValueError('a file named outside in/: ' + item['path'])
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, 'wb') as handle:
                handle.write(base64.b64decode(item['data']))
        with open(os.path.join(work, 'main.py'), 'w', encoding='utf-8') as handle:
            handle.write(request['code'])

        environment = {
            'HOME': work,
            'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'),
            'LANG': 'C.UTF-8',
            # Charts are drawn to files: there is no screen, and the image is read-only.
            'MPLBACKEND': 'Agg',
            'MPLCONFIGDIR': os.path.join(base, 'matplotlib'),
            # One CPU is what the container has; more threads only contend for it.
            'OPENBLAS_NUM_THREADS': '1',
            'OMP_NUM_THREADS': '1',
        }
        timed_out = False
        limit = int(request['printMax'])
        with open(os.path.join(base, 'stdout'), 'w+b') as stdout, open(os.path.join(base, 'stderr'), 'w+b') as stderr:
            child = subprocess.Popen(
                [sys.executable, '-I', 'main.py'],
                cwd=work, env=environment, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                start_new_session=True,
            )
            try:
                code = child.wait(timeout=seconds)
            except subprocess.TimeoutExpired:
                timed_out = True
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                code = child.wait()
            out_text, out_more = printed(stdout, limit)
            err_text, err_more = printed(stderr, limit)

        answer = {
            'exit': code,
            'timedOut': timed_out,
            'stdout': out_text, 'stdoutMore': out_more,
            'stderr': err_text, 'stderrMore': err_more,
            'files': [],
        }
        if code == 0 and not timed_out:
            files, refused = collect(os.path.join(work, 'out'), int(request['maxFiles']), int(request['maxBytes']))
            if refused:
                answer['refused'] = refused
            else:
                answer['files'] = files
        sys.stdout.write(json.dumps(answer))
        sys.stdout.flush()
    finally:
        shutil.rmtree(base, ignore_errors=True)


main()
