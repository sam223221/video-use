"""Core (non-router) machinery for the Studio v2 relay.

Step 1 modules: ``applog`` (rotating file log), ``events`` (SSE framing),
``tls`` (shared-CA leaf issuance). Step 3 adds ``bridge`` (device-tool
bridge) and ``turns`` (turn-survival buffer).
"""
