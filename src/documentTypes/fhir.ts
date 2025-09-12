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
  buildWorkflow
});
