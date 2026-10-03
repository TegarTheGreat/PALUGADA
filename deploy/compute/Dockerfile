# The image `code.compute` runs a role's Python in (src/capabilities/compute.ts):
# Python and the libraries a company's figures want, and nothing of PALUGADA.
# The program that runs the code is handed over with each call, so upgrading
# PALUGADA does not mean rebuilding this; rebuilding it upgrades the libraries.
#
#   docker build --tag palugada/compute:1 deploy/compute
#   PALUGADA_COMPUTE_IMAGE=palugada/compute:1
#
# It runs with no network, as nobody, on a read-only root: whatever a role's
# code needs must already be here. `npm run compute:check` proves the rest.
FROM python:3.13-slim

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore \
    PYTHONDONTWRITEBYTECODE=1

# Tables and spreadsheets, the arithmetic under them, and charts drawn to a
# file. Pinned, so an image built next month computes what this one did.
RUN pip install --no-cache-dir \
      pandas==3.0.6 \
      numpy==2.4.6 \
      openpyxl==3.1.5 \
      matplotlib==3.11.2

# Nobody, as the container is started whatever this says.
USER 65534:65534
