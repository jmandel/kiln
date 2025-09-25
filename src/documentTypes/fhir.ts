import type { DocumentWorkflow, FhirInputs } from '../types';
import { registry } from './registry';
import { buildFhirWorkflow } from '../workflows/fhir';
import { FhirInputForm, FhirPreview } from '../components/documents/FhirInputForm';

function buildWorkflow(inputs: FhirInputs): DocumentWorkflow<FhirInputs> {
  return buildFhirWorkflow(inputs);
}

registry.register('fhir', {
  inputsShape: { noteText: '', source: undefined },
  InputComponent: FhirInputForm,
  previewComponent: FhirPreview,
  buildWorkflow,
  getTitle(inputs) {
    if (inputs.source?.title) {
      return `FHIR: ${inputs.source.title}`;
    }
    if (inputs.source?.jobId) {
      return `FHIR from ${String(inputs.source.jobId).slice(-8)}`;
    }
    if (inputs.noteText && inputs.noteText.trim()) {
      return `FHIR from pasted note (${inputs.noteText.slice(0, 24)}...)`;
    }
    return 'FHIR Bundle';
  },
});
