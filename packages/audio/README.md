# @truevine/audio

Framework-agnostic audio ports, validation and provider adapters. The application
persists organization-scoped metadata in PostgreSQL and stores private audio
objects through the `AudioObjectStore` port. Provider SDKs live only beneath
`src/adapters/<provider>/`.

Current production adapters use S3-compatible object storage and Amazon Polly.
S3 objects are private, encrypted at rest by the provider, and exposed only by
short-lived signed playback URLs after the API authorizes the tenant request.
Credentials are supplied by the runtime's AWS credential chain; they never
belong in source or browser code. The API disables audio mutations when the
required bucket/region configuration is absent.
