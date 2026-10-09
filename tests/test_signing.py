import base64

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from kalshi_bot.kalshi_client import KalshiClient, sign


def test_rsa_pss_signature_verifies_and_ignores_query():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    sig = sign(key, "1703123456789", "GET", "/trade-api/v2/portfolio/orders?limit=5")
    key.public_key().verify(
        base64.b64decode(sig),
        b"1703123456789GET/trade-api/v2/portfolio/orders",
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH),
        hashes.SHA256(),
    )


def test_headers_sign_full_path():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    c = KalshiClient("https://external-api.demo.kalshi.co/trade-api/v2", "key-id", key)
    h = c._headers("GET", "/portfolio/balance")
    assert h["KALSHI-ACCESS-KEY"] == "key-id"
    msg = f"{h['KALSHI-ACCESS-TIMESTAMP']}GET/trade-api/v2/portfolio/balance".encode()
    key.public_key().verify(
        base64.b64decode(h["KALSHI-ACCESS-SIGNATURE"]),
        msg,
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH),
        hashes.SHA256(),
    )


def test_no_auth_headers_without_key():
    c = KalshiClient("https://external-api.kalshi.com/trade-api/v2")
    assert "KALSHI-ACCESS-KEY" not in c._headers("GET", "/markets")
