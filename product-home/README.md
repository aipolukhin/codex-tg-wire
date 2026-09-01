# Razvilka Product Home

Owner-only Telegram Mini App for reading accepted STVOR product decisions from
Git. The browser receives no cards until the server validates Telegram
`initData`, its age and the exact owner allowlist.

## Build

```sh
npm ci
npm run build
cd ../plugin
bun test tests/product-home
bun build --compile src/product-home/main.ts --outfile ../product-home-server
```

The production service serves the Vite build and read-only API from one origin.
It reads `docs/product/` from a Git checkout on every request; SQLite is not a
second product-decision store.

## Kama layout

```text
/opt/razvilka-product-home/
├── current -> releases/<release>/
├── previous -> releases/<previous>/
├── repository.git/
└── repository/
/etc/razvilka-product-home/
├── config.json
└── telegram-token
```

The bare repository's `post-receive` hook refreshes the read-only checkout after
the existing bot pushes an accepted decision. The canonical Git remote remains
the first push URL; Kama is the second Git-native copy used by Product Home.

The dedicated `product.whynaut.ru` nginx server proxies its root to loopback
port 8788. Static files contain neither decisions nor credentials.
