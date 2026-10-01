ci: run the doctor suite on stdlib unittest instead of pytest

CI failed on the first push: `actions/setup-python` does not install pytest,
and ubuntu-latest has no docker or psql either. The tests never needed any of
that - they are written on unittest, so the workflow now runs
`python3 -m unittest discover`, which needs no install step and matches what a
contributor can run with plain python3.

Verified locally: 19 tests, OK.