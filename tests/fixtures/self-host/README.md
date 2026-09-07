# Local HTTPS fixture only

`test-only-key.pem` and `test-only-cert.pem` are a publicly committed, self-signed
test pair for the isolated loopback HTTPS proxy in `scripts/verify-self-host.mjs`.
They are not application credentials and must never be used in a deployment.
The certificate contains only `127.0.0.1` and `localhost` SANs.

The browser smoke explicitly ignores certificate verification errors. It tests
actual HTTPS browser behavior, secure cookies and streaming through a local
reverse proxy; it does not validate public certificate issuance, DNS, a Linux
runtime, a production proxy configuration or a physical phone.

Regenerate with OpenSSL when necessary:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout test-only-key.pem -out test-only-cert.pem -sha256 -days 3650 -subj '/CN=Uimori test fixture ONLY' -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost'
```
