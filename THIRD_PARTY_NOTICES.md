# Third-party software and notices

Monrad Estimator's own source code is licensed under MIT. Third-party software is licensed independently by its respective copyright holders; the repository's MIT licence does not replace or relicense those components.

## Source checkout

The source repository declares npm dependencies in the root, client, server and E2E package manifests. The committed [package-lock.json](package-lock.json) identifies resolved package versions and declared licences. npm downloads these packages separately, and their original package distributions contain the applicable licence and copyright information. Preserve the upstream notices when redistributing their code.

The application uses, among others, React, React Router, TanStack Query, TipTap, dnd-kit, Recharts, Express, Prisma, Puppeteer, PostgreSQL client libraries, DOMPurify and JSZip. The exact versions and transitive dependencies are recorded in the lockfile. Licence examples include MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, MIT-0 and other permissive terms. DOMPurify is offered under MPL-2.0 OR Apache-2.0; Apache-2.0 is the intended permissive option for a compliant distribution. JSZip is offered under MIT OR GPL-3.0-or-later; MIT is the intended option. Conjunctive licences, such as MIT AND ISC, require compliance with both terms. These choices do not remove upstream notice obligations.

## Redistributable artefacts

A source dependency inventory does not establish which third-party code is included in a built frontend, server package, container or other distributable. Required original licence, copyright and NOTICE text must accompany redistributed material as applicable. The relevant package licences and notices must be checked against the actual artefact, rather than treating this source-level document as a complete binary-distribution notice.

The repository also downloads a Puppeteer-managed Chrome browser for PDF generation. Chrome/Chromium is not covered merely by the npm inventory. If a browser binary is redistributed, its applicable third-party licence and notice requirements must be reviewed and preserved.

The [release attribution issue](https://github.com/NickMonrad/monrad-estimator/issues/492) tracks this release-specific verification. Its linked audit evidence covers 417 installed production packages and records 18 entries requiring manual review and four platform-omitted optional packages. Those findings must be resolved against the actual release contents before claiming complete redistribution compliance.

## Development tools and other assets

Development-only dependencies remain subject to their own licences when separately redistributed. The same principle applies to any third-party fonts, icons, images, templates or other assets actually included in a release. This document does not grant rights to third-party trademarks, hosted services, or user-supplied content.
