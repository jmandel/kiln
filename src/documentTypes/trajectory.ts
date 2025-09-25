import type { DocumentWorkflow, TrajectoryInputs } from '../types';
import { registry } from './registry';
import { buildTrajectoryWorkflow } from '../workflows/trajectory';
import { TrajectoryInputForm, TrajectoryPreview } from '../components/documents/TrajectoryInputForm';

function buildWorkflow(inputs: TrajectoryInputs): DocumentWorkflow<TrajectoryInputs> {
  return buildTrajectoryWorkflow(inputs);
}

registry.register('trajectory', {
  inputsShape: { trajectorySketch: '' },
  InputComponent: TrajectoryInputForm,
  previewComponent: TrajectoryPreview,
  buildWorkflow,
});
