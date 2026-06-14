"""Studio v2 relay — FastAPI brain relay (auth, TLS, agent, device-tool bridge).

The relay carries JSON and static files ONLY — never one byte of media.
Projects, clips, the EDL and the chat transcript all live on the device (OPFS).
See PM/arch-2026-06-12-m1-core-loop.md for the authoritative contract.
"""
