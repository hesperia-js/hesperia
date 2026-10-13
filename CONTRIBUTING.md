# Contributing

## Issues and pull requests

Use [GitHub Issues](https://github.com/hesperia-js/hesperia/issues) to track
bugs and proposed changes. Search existing issues before opening one. For a bug
report, include the Hesperia revision or package version, the relevant runtime
and browser, a minimal reproduction, and the expected and actual behavior.
Discuss changes to public behavior before implementing them.

Keep branches short-lived and use these names in this repository:

| Branch              | Purpose               | Example                  |
| ------------------- | --------------------- | ------------------------ |
| `feature/<name>`    | New features          | `feature/native-routing` |
| `fix/<name>`        | Fixes and hotfixes    | `fix/route-matching`     |
| `release/<VERSION>` | Release stabilization | `release/1.0.0`          |

Fork branch names are exempt, though following the same convention is welcome.
`main` remains the integration branch.

CI enforces these source-branch names for same-repository pull requests. A release
branch version must match the shared root and publishable-package versions, without
a `v` prefix. See [CI and npm releases](docs/ci.md) for required checks, supported
versions, and publishing steps.

Open feature and fix pull requests against `main`. During release stabilization,
open release-fix pull requests from `fix/<name>` against the relevant
`release/<VERSION>` branch.

Use the [pull request template](.github/pull_request_template.md) to explain the
change, link its issue when one exists, and report verification results. Use
`Closes #123` only when the pull request resolves that issue. Follow the
[AI contribution policy](AI_POLICY.md) and this [Code of Conduct](CODE-OF-CONDUCT.md).
Record the [contributor agreement acceptance](#recording-cla-acceptance) before
merge.

## Getting started

Use Bun to install dependencies and run the development tools:

```sh
bun install
bun run build
bun run typecheck
bun run test
bun run lint
bun run fmt:check
```

Build before typechecking: consumer checks resolve the package's emitted
declarations in `dist/`. `bun run check` performs that build first, then runs
typechecking, lint, formatting checks, and the deterministic, browser, package,
golden, and editor test suites.

Use `bun run fmt -- <paths>` to format the files you change. Keep unrelated
work intact, including files in the neighboring Aeolia repository.

The workspace installs the exact published `aeolia@1.0.0-alpha.1` dependency;
building Hesperia does not require an Aeolia source checkout. CI always builds,
typechecks, lints, and checks formatting. Ordinary pull requests can select test
suites; release pull requests and full runs retain all platform and coverage gates.

## Where code belongs

The compiler in `packages/compiler/src/` owns source analysis, checking views,
canonical representation, code generation, and filesystem route scanning.
The runtime package in `packages/hesperia/src/` owns component lifetimes, DOM
objects, bindings, structural changes, effects, and browser routing. Its
`client.ts` connects authored operations to their component owner; its `data/`
directory adapts Aeolia to that lifetime. Aeolia remains independent and owns
the reactive engine and shared stores. Hesperia uses Aeolia's public interfaces.

Project configuration, commands, browser bundling, and local servers belong in
`packages/tooling/src/` and stay outside browser application bundles. The
language server in `packages/language-server/src/` adapts compiler information
to editor requests and shares tooling's project service. The VS Code client
remains in `editors/vscode/`. Package export maps expose the supported entry
points; source-directory imports are for repository tests, not applications.

The root Bun workspace owns dependency installation and the ordered package
build. Each package emits its own `dist/`; build before checking consumers.
Keep optional integrations and their dependencies in their own packages.

Before adding a dependency, review its maintenance, evidence of substantial
adoption, and transitive dependency count and risk. Treat download counts as one
signal, not a guarantee of quality or maintenance; use judgment rather than a
numeric cutoff.

Before changing behavior, read the relevant guide in `docs/`, public API
declarations, and owning tests. Keep the documented contract consistent across
compiler, runtime, types, and tests. Ask the maintainer about conflicting or
unspecified behavior; a test written around a different behavior does not approve
that change.

## Tests

Prefer integration tests of public behavior and complete application workflows.
For a bug fix, write the smallest scenario that would have caught the bug.
Check the wrong result, not just whether the code ran.

Keep lifecycle distinctions intact when consolidating tests: a live store is
not equivalent to an unobserved one, and a warmed computed is not equivalent to
one that has never been read. Use strict equality for emitted-value sequences
where absence and a real `undefined` must be distinguished.

Use fake time for freshness and collection, not synchronous signal propagation.
Prefer observable completion over sleeps or guessed microtask counts. Keep
manual profiling outside the deterministic suite.

Aim for complete meaningful line and function coverage. CI accepts the union of
the Windows and Linux captures when it exceeds 85% line coverage and reaches at
least 90% function coverage. The standalone coverage checker remains a 90% line
and function diagnostic. Bun's native report provides line and function
coverage. The canonical LCOV report also records branches for diagnostics, but
the combined gate does not enforce a branch threshold. Percentages do not
replace behavioral assertions.

See [test ownership and commands](tests/README.md). Run focused tests while
working, then the complete suite. Consumer-type fixtures and package-artifact
tests must continue to check the emitted public package, not only source imports.

## Documentation and review

Document public functions, types, options, callbacks, and lifecycle behavior
with TSDoc. Explain what the signature cannot: ownership, timing, cancellation,
equality, failure, and cleanup. Keep examples small and type-correct.

Keep the README introductory. Put user-facing behavioral detail in `docs/`
and contributor guidance here. Prefer concrete prose and useful variable names.
Comments should explain a non-obvious constraint, not repeat the next line.

Repository documentation explains current behavior, setup, usage, APIs, and
maintenance. It must be usable from a standalone checkout: include the applicable
rules or link to other repository guides or public references. Keep design
proposals, decision history, research, milestone plans, and handoffs outside this
repository, and do not reference private workspace files from repository docs.

Before handing over a change, run formatting, lint, typecheck, and the full test
suite. After public API or TSDoc changes, inspect the emitted declarations too.
State any checks that failed or could not run; do not describe a partial check
as a clean result.

Automated contributors must also follow [AGENTS.md](AGENTS.md).

## Contribution licensing

The Software's public source is licensed under [MPL-2.0](COPYING). The project also
plans to offer alternative commercial licenses, as described in
[the commercial agreement](LICENSE-COMMERCIAL.md).

Contributors retain ownership of their contributions. The contributor agreement
below authorizes Werberth Lins, the project licensor, upon acceptance, to include
contributions in public MPL and alternative commercial releases.

Only grant rights you own or are authorized to grant. If your employer or another
party owns the contribution, acceptance must come from someone authorized to act
for that rights holder. Disclose third-party material and its license; submitting
it does not give the project additional rights to that material.

### Recording CLA acceptance

Each contributor must explicitly accept the CLA by checking an acceptance box
in the pull request description. The statement must identify the agreement
version, link to an immutable copy of its full terms, and confirm that the
contributor owns the necessary rights or is authorized by the rights holder to
grant them. Leave the box unchecked by default; maintainers must not check it
on a contributor's behalf.

Before merging, maintainers must verify and retain the acceptance record and
the referenced agreement version. A PR author's acceptance does not cover
other contributors' rights without their authorization; obtain the necessary
acceptance for each rights holder whose work requires the grant.

Retain the contributor's acceptance text, its timestamp and account, the
identified agreement version, and the covered contribution revision. For an
organization-owned contribution, verify and retain evidence that the accepting
representative may grant the required rights. Do not merge while ownership or
authority remains unresolved. A commit signature or company email address alone
does not establish authority to grant an organization's intellectual-property
rights.

### Contributor License Agreement

#### C1. Parties, contribution, and acceptance

This agreement is between Werberth Lins (the project licensor) and the individual
or organization identified as the contributor in the acceptance record. An
organization accepts through a representative authorized to grant these rights.
Ownership is not inferred solely from the identity of the GitHub account.

**Software** means the software project identified in the root LICENSE of the
repository in which the project licensor publishes this agreement. The
acceptance record identifies that repository and the covered pull request.
Copying the agreement or moving a repository does not expand the grant to
unrelated software or contributions.

A contribution is the code or documentation intentionally submitted for inclusion
in Software in the identified pull request, including revisions expressly covered
by the contributor's acceptance. This agreement does not cover unrelated work,
private repositories, or contributions to other projects. Later pull requests require
their own acceptance. Material identified as belonging to another rights holder
is not included in this grant without that holder's authorization.

Acceptance requires an affirmative statement in the pull request identifying
the agreement version and an immutable link to it.
That statement must identify the covered contribution and the rights holder on
whose behalf it is made. Publication of a PR alone is not acceptance. The project
retains the acceptance record and agreement version; sensitive identity or
employer-authorization evidence need not be posted in the public PR.

#### C2. Ownership and copyright permission

You retain ownership of your contribution and may use your own work elsewhere.
You grant the project licensor a non-exclusive, worldwide, royalty-free copyright
license for the duration of the applicable copyright to reproduce, modify,
incorporate, display, perform, distribute, and sublicense your contribution and
adaptations as part of Software. This includes both MPL-2.0 releases and releases
under alternative commercial terms, including proprietary distribution without
the source-availability requirements of MPL. The permission includes sublicensing
through authorized commercial licensing representatives and to customers within
their Software licenses; it does not transfer your ownership to those parties.

This permission is intended to be irrevocable to the extent allowed by law,
subject to this agreement. You receive no royalties or share of commercial license
fees under this agreement. The licensor's commercial support promises impose no
maintenance or customer-support duty on you.

Contributions incorporated into the public Software project remain available under
MPL-2.0. Neither this agreement nor a commercial sublicense withdraws MPL rights
already granted in public releases.

#### C3. Notices and authorship

For authorized alternative commercial distributions, you permit omission of
license and copyright notices relating to your contribution to the extent you
may lawfully authorize it, and allow the licensor to pass on that permission.
Public MPL distributions remain subject to MPL notice requirements. This clause
does not authorize false authorship claims, waive non-waivable rights, or waive
third-party notices. It grants no trademark rights.

This permission does not extinguish an author's right to claim authorship or
remove attribution required by applicable law, including for documentation or
other material governed by rules different from those for computer programs.
A public contribution record does not replace legally required attribution in
a distribution.

#### C4. Contribution-specific patents

For use of the contribution as part of Software, you grant the project licensor
royalty-free permission under patent claims you control that are necessarily
practiced by the contribution alone or combined with Software
as submitted. The grant permits making, using, selling, importing, and distributing
that implementation for the life of those claims, with permission to sublicense
through Software's applicable public or commercial license, including through the
authorized commercial licensing representatives described in C2.

Recipients receive patent permissions under their applicable Software license.
Commercial recipients' permissions are subject to that commercial agreement's
scope, duration, termination, and expressly surviving recipient rights. This
agreement does not give them a separate patent license for the life of the claims
or extend their commercial coverage. Independent grants under MPL-2.0 remain
governed by MPL-2.0.

This grant supplies no rights under unrelated patents or third-party patents
and does not cover infringement caused solely by later changes
or combinations outside that submitted implementation. It is not a guarantee that
Software is free of third-party patent claims.

#### C5. Authority, third-party material, and support

You confirm that you own the contribution or have authority to grant the rights
in this agreement. If an employer or another person owns any relevant rights,
obtain the necessary authorization before accepting. Identify third-party material,
its source, applicable licenses, and restrictions known to you. Notify the project
if you learn that your authority or disclosures were materially inaccurate.

Except for those representations and obligations imposed by law, contributions
are provided as is, without promises of error-free operation or fitness for a
particular application. You undertake no support commitment and no contractual
obligation to defend or indemnify the licensor or its customers. Mandatory rights
and obligations remain unaffected. The project is not obliged to merge a PR.

These disclaimers do not excuse a false statement of ownership or authority,
breach of the express representations in this agreement, or liability imposed
by applicable law. They create no separate duty to conduct or fund another
party's defense.

#### C6. Versions and applicable law

Changes to this agreement require fresh acceptance for the affected contribution;
editing CONTRIBUTING does not retroactively change earlier grants. This agreement
does not replace a customer's commercial license or impose its payment obligations
on contributors. It is governed by Brazilian law with disputes submitted to the
competent courts in Brazil, subject to mandatory jurisdiction and protections
that cannot be displaced by agreement. An unenforceable term is ineffective to
the extent required by law; the remaining terms continue where legally possible.
