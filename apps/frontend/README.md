# Frontend Foundation

Dependency dan script berada dalam manifest root. Dari root repository:

```sh
bun run build:frontend
bun run test:frontend
bun run api:sync
```

Workflow development lengkap memakai `bun run doctor` serta `bun run serve`. Pembuktian kerangka spec 0001 tanpa database memakai `bun run dev:frontend` dan `bun run dev:backend` pada terminal terpisah. SDK di `sdk/` dikelola generator.
