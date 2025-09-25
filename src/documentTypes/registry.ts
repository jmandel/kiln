import type { DocumentTypeRegistry, DocumentTypeDef, InputsUnion, DocumentType } from '../types';

const defs = new Map<DocumentType, DocumentTypeDef<InputsUnion>>();

export const registry: DocumentTypeRegistry = {
  register<T extends InputsUnion>(type: DocumentType, def: DocumentTypeDef<T>): void {
    defs.set(type, def as DocumentTypeDef<InputsUnion>);
  },
  get<T extends InputsUnion>(type: DocumentType): DocumentTypeDef<T> | undefined {
    const d = defs.get(type);
    return d as DocumentTypeDef<T> | undefined;
  },
  all(): Array<{ type: DocumentType; def: DocumentTypeDef<InputsUnion> }> {
    return Array.from(defs.entries()).map(([type, def]) => ({
      type,
      def,
    }));
  },
};
