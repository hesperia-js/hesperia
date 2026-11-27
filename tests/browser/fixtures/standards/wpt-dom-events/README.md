# DOM event reference cases

The two `.js.txt` files contain unchanged Web Platform Tests originals from commit
[`01591897eff8424a3ead6e79f5ee5d1c39fb1437`](https://github.com/web-platform-tests/wpt/tree/01591897eff8424a3ead6e79f5ee5d1c39fb1437/dom/events).
The `.txt` suffix keeps the originals as reference material rather than runnable
fixtures. They retain their upstream bytes under the accompanying BSD 3-Clause
license in `LICENSE.md.txt`; this directory is not a runnable WPT harness.

`tests/browser/native.spec.ts` adapts the nested `once` dispatch assertion from
`AddEventListenerOptions-once.any.js` and the passive `returnValue` assertion
from `AddEventListenerOptions-passive.any.js`. The adapted application uses
compiled Hesperia handlers and compares them with separately asserted native
browser controls. Hesperia's listener-pair options accept boolean values; the
upstream getter and numeric-coercion cases are not included in this adaptation.
No other upstream cases in these files are claimed by the adapted test.
