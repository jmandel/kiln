import type { DocumentTypeRegistry, DocumentTypeDef, InputsUnion } from '../types';

const defs = new Map<string, DocumentTypeDef<InputsUnion>>();

export const registry: DocumentTypeRegistry = {
  register<T extends InputsUnion>(type: 'narrative' | 'fhir', def: DocumentTypeDef<T>): void {
    defs.set(type, def as DocumentTypeDef<InputsUnion>);
  },
  get<T extends InputsUnion>(type: 'narrative' | 'fhir'): DocumentTypeDef<T> | undefined {
    const d = defs.get(type);
    return d as DocumentTypeDef<T> | undefined;
  },
  all(): Array<{ type: 'narrative' | 'fhir'; def: DocumentTypeDef<InputsUnion> }> {
    return Array.from(defs.entries()).map(([type, def]) => ({
      type: type as 'narrative' | 'fhir',
      def,
    }));
  },
};
