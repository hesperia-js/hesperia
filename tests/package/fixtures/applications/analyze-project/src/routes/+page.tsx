import { generatedValue } from "hesperia:plugin/installed-analysis";
import { capturedValue } from "../shared-value";

export default function Page() {
  return (
    <main>
      <output id="captured">{capturedValue}</output>
      <output id="generated">{generatedValue()}</output>
    </main>
  );
}
