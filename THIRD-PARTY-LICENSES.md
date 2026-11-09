# Third-Party Licences

This document lists the open-source libraries used by **mcp-azure-storage**,
together with their resolved versions and licence identifiers.

> **Generated:** 2026-11-09
> **Project licence:** Apache-2.0 (see [LICENSE](LICENSE))

---

## Licence Summary

| Licence | Count | Packages |
|---------|------:|----------|
| MIT | 17 | Azure SDKs, MCP SDK, Express, Helmet, cors, busboy, dotenv (note: BSD-2), express-rate-limit, Zod, dev tooling |
| Apache-2.0 | 11 | OpenTelemetry family, TypeScript |
| BSD-2-Clause | 1 | dotenv |

All licences listed below are permissive and compatible with the project's
Apache-2.0 licence.

---

## Production Dependencies

| Package | Version | Licence | Repository |
|---------|---------|---------|------------|
| `@azure/data-tables` | 13.3.2 | MIT | [github.com/Azure/azure-sdk-for-js](https://github.com/Azure/azure-sdk-for-js/tree/main/sdk/tables/data-tables) |
| `@azure/identity` | 4.14.0 | MIT | [github.com/Azure/azure-sdk-for-js](https://github.com/Azure/azure-sdk-for-js/tree/main/sdk/identity/identity) |
| `@azure/storage-blob` | 12.34.0 | MIT | [github.com/Azure/azure-sdk-for-js](https://github.com/Azure/azure-sdk-for-js/tree/main/sdk/storage/storage-blob) |
| `@azure/storage-file-share` | 12.33.0 | MIT | [github.com/Azure/azure-sdk-for-js](https://github.com/Azure/azure-sdk-for-js/tree/main/sdk/storage/storage-file-share) |
| `@azure/storage-queue` | 12.32.0 | MIT | [github.com/Azure/azure-sdk-for-js](https://github.com/Azure/azure-sdk-for-js/tree/main/sdk/storage/storage-queue) |
| `@modelcontextprotocol/sdk` | 1.32.1 | MIT | [github.com/modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) |
| `@opentelemetry/api` | 1.9.1 | Apache-2.0 | [github.com/open-telemetry/opentelemetry-js](https://github.com/open-telemetry/opentelemetry-js/tree/main/api) |
| `@opentelemetry/auto-instrumentations-node` | 0.79.0 | Apache-2.0 | [github.com/open-telemetry/opentelemetry-js-contrib](https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/metapackages/auto-instrumentations-node) |
| `@opentelemetry/exporter-logs-otlp-http` | 0.221.0 | Apache-2.0 | [github.com/open-telemetry/opentelemetry-js](https://github.com/open-telemetry/opentelemetry-js/tree/main/experimental/packages/exporter-logs-otlp-http) |
| `@opentelemetry/exporter-metrics-otlp-http` | 0.221.0 | Apache-2.0 | [github.com/open-telemetry/opentelemetry-js](https://github.com/open-telemetry/opentelemetry-js/tree/main/experimental/packages/opentelemetry-exporter-metrics-otlp-http) |
| `@opentelemetry/exporter-trace-otlp-http` | 0.221.0 | Apache-2.0 | [github.com/open-telemetry/opentelemetry-js](https://github.com/open-telemetry/opentelemetry-js/tree/main/experimental/packages/exporter-trace-otlp-http) |
| `@opentelemetry/resources` | 2.12.0 | Apache-2.0 | [github.com/open-telemetry/opentelemetry-js](https://github.com/open-telemetry/opentelemetry-js/tree/main/packages/opentelemetry-resources) |
| `@opentelemetry/sdk-logs` | 0.221.0 | Apache-2.0 | [github.com/open-telemetry/opentelemetry-js](https://github.com/open-telemetry/opentelemetry-js/tree/main/experimental/packages/sdk-logs) |
| `@opentelemetry/sdk-metrics` | 2.12.0 | Apache-2.0 | [github.com/open-telemetry/opentelemetry-js](https://github.com/open-telemetry/opentelemetry-js/tree/main/packages/sdk-metrics) |
| `@opentelemetry/sdk-node` | 0.221.0 | Apache-2.0 | [github.com/open-telemetry/opentelemetry-js](https://github.com/open-telemetry/opentelemetry-js/tree/main/experimental/packages/opentelemetry-sdk-node) |
| `@opentelemetry/semantic-conventions` | 1.43.0 | Apache-2.0 | [github.com/open-telemetry/opentelemetry-js](https://github.com/open-telemetry/opentelemetry-js/tree/main/packages/opentelemetry-semantic-conventions) |
| `busboy` | 1.6.0 | MIT | [github.com/mscdex/busboy](https://github.com/mscdex/busboy) |
| `cors` | 2.8.6 | MIT | [github.com/expressjs/cors](https://github.com/expressjs/cors) |
| `dotenv` | 17.4.2 | BSD-2-Clause | [github.com/motdotla/dotenv](https://github.com/motdotla/dotenv) |
| `express` | 5.2.1 | MIT | [github.com/expressjs/express](https://github.com/expressjs/express) |
| `express-rate-limit` | 8.7.1 | MIT | [github.com/express-rate-limit/express-rate-limit](https://github.com/express-rate-limit/express-rate-limit) |
| `helmet` | 8.3.0 | MIT | [github.com/helmetjs/helmet](https://github.com/helmetjs/helmet) |
| `zod` | 4.6.7 | MIT | [github.com/colinhacks/zod](https://github.com/colinhacks/zod) |

## Development Dependencies

These packages are used only during development, testing, and build.
They are **not** included in the production Docker image or runtime bundle.

| Package | Version | Licence | Repository |
|---------|---------|---------|------------|
| `@types/cors` | 2.8.19+ | MIT | [github.com/DefinitelyTyped/DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| `@types/express` | 5.0.6+ | MIT | [github.com/DefinitelyTyped/DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| `@types/node` | 25.5.0+ | MIT | [github.com/DefinitelyTyped/DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| `@types/supertest` | 7.2.0+ | MIT | [github.com/DefinitelyTyped/DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| `@vitest/coverage-v8` | 5.0.5 | MIT | [github.com/vitest-dev/vitest](https://github.com/vitest-dev/vitest) |
| `supertest` | 7.3.1 | MIT | [github.com/ladjs/supertest](https://github.com/ladjs/supertest) |
| `tsx` | 4.23.15 | MIT | [github.com/privatenumber/tsx](https://github.com/privatenumber/tsx) |
| `typescript` | 6.0.3 | Apache-2.0 | [github.com/microsoft/TypeScript](https://github.com/microsoft/TypeScript) |
| `vite` | 6.4.5 | MIT | [github.com/vitejs/vite](https://github.com/vitejs/vite) |
| `vitest` | 5.0.5 | MIT | [github.com/vitest-dev/vitest](https://github.com/vitest-dev/vitest) |

## Overrides

The following version overrides are applied in [`package.json`](package.json):

| Package | Minimum Version | Reason |
|---------|----------------|--------|
| `@azure/msal-node` | >=7.1.1 | Security patch for transitive dependency via `@azure/identity` |

---

## Licence Texts

### MIT Licence

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Apache Licence, Version 2.0

The full text of the Apache Licence 2.0 is available at:
<https://www.apache.org/licenses/LICENSE-2.0>

### BSD 2-Clause Licence ("Simplified")

```
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
