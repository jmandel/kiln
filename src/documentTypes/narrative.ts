import type { DocumentWorkflow, NarrativeInputs } from '../types';
import { registry } from './registry';
import { buildNarrativeWorkflow } from '../workflows/narrative';
import { NarrativeInputForm, NarrativePreview } from '../components/documents/NarrativeInputForm';

function buildWorkflow(inputs: NarrativeInputs): DocumentWorkflow<NarrativeInputs> {
  return buildNarrativeWorkflow(inputs);
}

registry.register('narrative', {
  inputsShape: { sketch: '' },
  InputComponent: NarrativeInputForm,
  previewComponent: NarrativePreview,
  buildWorkflow,
});
