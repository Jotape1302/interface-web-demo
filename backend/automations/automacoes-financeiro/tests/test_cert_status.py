from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

from app import cert_status


def _write_pfx(path, not_after, password=b"segredo"):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "FABRILUX ACABAMENTOS LTDA:43820617000166"),
        x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "SP"),
    ])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(not_after - timedelta(days=365))
        .not_valid_after(not_after)
        .sign(key, hashes.SHA256())
    )
    path.write_bytes(
        pkcs12.serialize_key_and_certificates(b"a1", key, cert, None, serialization.BestAvailableEncryption(password))
    )


def _cfg(tmp_path):
    return SimpleNamespace(SEFAZ_CERTS_DIR=tmp_path, SEFAZ_CERT_PATH=None, SEFAZ_CERT_PASSWORD="segredo")


def test_certificado_perto_de_vencer_gera_alerta(tmp_path, monkeypatch):
    now = datetime(2026, 9, 23, tzinfo=timezone.utc)
    _write_pfx(tmp_path / "fabrilux.pfx", now + timedelta(days=12, hours=1))
    monkeypatch.setattr(cert_status, "collect_candidate_passwords", lambda path, cfg: ["errada", "segredo"])

    [info] = cert_status.get_certificates_status(_cfg(tmp_path), now=now)

    assert info["cnpj"] == "43820617000166"
    assert info["titular"] == "FABRILUX ACABAMENTOS LTDA"
    assert info["dias_restantes"] == 12
    assert info["alerta"] is True
    assert info["erro"] is None


def test_certificado_valido_por_muito_tempo_nao_alerta(tmp_path, monkeypatch):
    now = datetime(2026, 9, 23, tzinfo=timezone.utc)
    _write_pfx(tmp_path / "fabrilux.pfx", now + timedelta(days=200))
    monkeypatch.setattr(cert_status, "collect_candidate_passwords", lambda path, cfg: ["segredo"])

    [info] = cert_status.get_certificates_status(_cfg(tmp_path), now=now)

    assert info["alerta"] is False


def test_senha_errada_reporta_erro_sem_quebrar(tmp_path, monkeypatch):
    _write_pfx(tmp_path / "outro.pfx", datetime(2027, 1, 1, tzinfo=timezone.utc))
    monkeypatch.setattr(cert_status, "collect_candidate_passwords", lambda path, cfg: ["errada"])

    [info] = cert_status.get_certificates_status(_cfg(tmp_path))

    assert info["valido_ate"] is None
    assert info["dias_restantes"] is None
    assert info["alerta"] is False
    assert "senha" in info["erro"]
