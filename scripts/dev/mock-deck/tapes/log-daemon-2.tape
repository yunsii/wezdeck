# log-daemon · task-otel-export · secondary
delay 900
prompt add OTLP/gRPC export for log records; respect existing field whitelist
delay 700
status running surveying export pipeline
read src/export/index.ts
delay 500
result current exporters: file, syslog, journald
delay 700
read src/lib/whitelist.ts
delay 500
result whitelist applied at producer · ok to reuse
delay 1100
heading Approach
type   add OtlpGrpcExporter implementing Exporter interface
delay 200
type   reuse @opentelemetry/exporter-logs-otlp-grpc directly
delay 200
type   feature-gate behind config.export.otlp = { endpoint, headers }
delay 800
write src/export/otlp-grpc.ts
delay 1700
result Created · 124 lines · batches at 256 records / 5 s
delay 700
edit src/export/index.ts
delay 1300
result Updated · OtlpGrpcExporter registered
delay 700
edit src/config/schema.ts
delay 1200
result Updated · zod schema for otlp config branch
delay 700
status waiting collector at otel.local:4317 — should I point integration test there or stand up a local one?
wait
status running spinning local collector via testcontainers
bash bun test test/export/otlp-grpc.integration.ts
delay 2800
result ✓ 6 pass · 0 fail · 4.2 s · all attrs preserved across export
delay 700
status done OTLP/gRPC export ready · endpoint configurable
delay 5000
clear
