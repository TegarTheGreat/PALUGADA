#!/usr/bin/env bash
# Run by the postgres image once, on an empty volume: the PALUGADA database and
# its three roles, with the passwords from the URLs compose hands this
# container. Not `exec`: the image sources scripts it cannot execute, and an
# exec there would replace its own entrypoint.
bash /palugada/setup-database.sh
