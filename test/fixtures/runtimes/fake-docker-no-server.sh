#!/bin/sh
# A docker CLI with no daemon behind it: `docker version --format
# {{.Server.Version}}` exits 0 and prints nothing, because the client half
# answered and the server half did not. This is the case that distinguishes
# `docker version` from `docker --version`, and it is why the health check
# looks at the output rather than at the exit code.
exit 0
