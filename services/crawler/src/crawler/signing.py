import hashlib
import hmac
import json
from typing import Any


def canonical(event: dict[str, Any]) -> bytes:
    """Canonical JSON of the event without `signature`: sorted keys, no whitespace, UTF-8."""
    body = {k: v for k, v in event.items() if k != "signature"}
    return json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sign(event: dict[str, Any], secret: bytes) -> str:
    return hmac.new(secret, canonical(event), hashlib.sha256).hexdigest()


def verify(event: dict[str, Any], keys: dict[str, bytes]) -> bool:
    """True if `keyId` is configured and the signature matches. Constant-time compare."""
    secret = keys.get(str(event.get("keyId")))
    if secret is None:
        return False
    return hmac.compare_digest(sign(event, secret), str(event.get("signature")))
