// Dense IPS profile guidance, grouped by resource type.
// These are ultra-compact checklists intended for LLM prompting.

export type IPSNotes = Record<string, {
  profile?: string | string[];
  requirements: string[];
  example?: string; // Pretty JSON (2 spaces), include display values and useful optional props
  variants?: Array<{ name: string; profile?: string; deltas: string[] }>;
}>;

export const IPS_NOTES: IPSNotes = {
  Composition: {
    profile: "http://hl7.org/fhir/uv/ips/StructureDefinition/Composition-uv-ips",
    requirements: [
      "status: final",
      "type: LOINC document type (use a sensible IPS-appropriate doc type)",
      "subject: Reference(Patient)",
      "encounter: Reference(Encounter) if available",
      "date: document timestamp",
      "author[0]: Reference(Practitioner|Organization)",
      "title: short document title",
      "section[]: use exact section titles from the note; set section.text.div to '{{Section Title}}' (placeholder for stitching)",
      "section.entry[]: References to resources only (no inline narrative in entries)",
    ],
    example: `{
  "resourceType": "Composition",
  "status": "final",
  "type": {
    "coding": [
      { "system": "http://loinc.org", "code": "60591-5", "display": "Patient summary Document" }
    ]
  },
  "subject": { "reference": "Patient/pat-1", "display": "Concise patient summary (age/sex/context)" },
  "encounter": { "reference": "Encounter/enc-1", "display": "Visit context (setting/reason)" },
  "date": "2023-09-15T10:30:00Z",
  "author": [ { "reference": "Practitioner/pract-1", "display": "Author name, role" } ],
  "title": "Patient Summary",
  "section": [
    {
      "title": "Past Medical History",
      "text": { "div": "<div>{{Past Medical History}}</div>" },
      "entry": [
        { "reference": "Condition/cond-htn-1", "display": "Hypertension — brief instruction to generate Condition" }
      ]
    },
    {
      "title": "Physical Examination",
      "text": { "div": "<div>{{Physical Examination}}</div>" }
    }
  ]
}`
  },

  Bundle: {
    profile: "http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips",
    requirements: [
      "type: document",
      "entry[0]: Composition (the document root)",
      "fullUrl: stable URN or absolute; all local references resolve within Bundle",
    ],
    example: `{
  "resourceType": "Bundle",
  "type": "document",
  "timestamp": "2023-09-15T10:30:00Z",
  "entry": [
    { "fullUrl": "urn:example:Composition/comp-1", "resource": { "resourceType": "Composition", "id": "comp-1" } },
    { "fullUrl": "urn:example:Patient/pat-1", "resource": { "resourceType": "Patient", "id": "pat-1", "name": [ { "family": "Doe", "given": ["Jane"] } ], "gender": "female", "birthDate": "1992-05-01" } }
  ]
}`
  },

  Patient: {
    profile: "http://hl7.org/fhir/uv/ips/StructureDefinition/Patient-uv-ips",
    requirements: [
      "identifier: include if available",
      "name: at least one HumanName",
      "gender, birthDate: populate when known",
      "telecom/address: optional but recommended",
    ],
    example: `{
  "resourceType": "Patient",
  "id": "pat-1",
  "identifier": [ { "system": "urn:oid:2.16.840.1.113883.2.4.6.3", "value": "574687583" } ],
  "active": true,
  "name": [ { "family": "Doe", "given": ["Jane"] } ],
  "telecom": [ { "system": "phone", "value": "+31788700800", "use": "home" } ],
  "gender": "female",
  "birthDate": "1992-05-01",
  "address": [ { "line": ["Laan Van Europa 1600"], "city": "Dordrecht", "postalCode": "3317 DB", "country": "NL" } ]
}`
  },

  Practitioner: {
    profile: "http://hl7.org/fhir/uv/ips/StructureDefinition/Practitioner-uv-ips",
    requirements: [
      "identifier and/or name",
      "telecom: optional",
    ]
  },

  PractitionerRole: {
    profile: "http://hl7.org/fhir/uv/ips/StructureDefinition/PractitionerRole-uv-ips",
    requirements: [
      "practitioner: Reference(Practitioner)",
      "organization: Reference(Organization) if available",
      "code/specialty: optional",
    ]
  },

  Organization: {
    profile: "http://hl7.org/fhir/uv/ips/StructureDefinition/Organization-uv-ips",
    requirements: [
      "identifier and/or name",
      "type: optional",
    ]
  },

  Condition: {
    profile: "http://hl7.org/fhir/uv/ips/StructureDefinition/Condition-uv-ips",
    requirements: [
      "subject: Reference(Patient)",
      "code: SNOMED CT disorder (1..1; ProblemsUvIps preferred)",
      "category: include problem-list-item",
      "clinicalStatus: HL7 condition-clinical (e.g., active)",
      "verificationStatus: HL7 condition-ver-status (e.g., confirmed)",
      "onset[x]: 0..1 when known (prefer onsetDateTime)",
      "bodySite/severity: optional; use SNOMED when present",
      "encounter: Reference(Encounter) if relevant",
    ],
    example: `{
  "resourceType": "Condition",
  "id": "cond-1",
  "subject": { "reference": "Patient/pat-1" },
  "clinicalStatus": { "coding": [ { "system": "http://terminology.hl7.org/CodeSystem/condition-clinical", "code": "active", "display": "Active" } ] },
  "category": [ { "coding": [ { "system": "http://terminology.hl7.org/CodeSystem/condition-category", "code": "problem-list-item", "display": "Problem List Item" } ] } ],
  "code": { "coding": [ { "system": "http://snomed.info/sct", "code": "313182004", "display": "Postconcussional syndrome (disorder)" } ], "text": "Post-concussion syndrome" },
  "onsetDateTime": "2023-09-15"
}`
  },

  Procedure: {
    profile: "http://hl7.org/fhir/uv/ips/StructureDefinition/Procedure-uv-ips",
    requirements: [
      "subject: Reference(Patient)",
      "status: e.g., completed",
      "code: SNOMED CT procedure",
      "performed[x]: when available (dateTime or Period)",
      "encounter: Reference(Encounter) if relevant",
    ],
    example: `{
  "resourceType": "Procedure",
  "id": "proc-1",
  "status": "completed",
  "category": { "coding": [ { "system": "http://snomed.info/sct", "code": "387713003", "display": "Surgical procedure" } ] },
  "code": { "coding": [ { "system": "http://snomed.info/sct", "code": "233258006", "display": "Arterial angioplasty" } ], "text": "Arterial angioplasty" },
  "subject": { "reference": "Patient/pat-1" },
  "performedDateTime": "2023-09-10"
}`
  },

  DiagnosticReport: {
    profile: "http://hl7.org/fhir/uv/ips/StructureDefinition/DiagnosticReport-uv-ips",
    requirements: [
      "subject: Reference(Patient)",
      "category: laboratory | imaging (per context)",
      "code: LOINC report/panel code",
      "effective[x]/issued: set appropriately",
      "result[]: References to Observation(s)",
      "specimen/performer: include when applicable",
    ],
    example: `{
  "resourceType": "DiagnosticReport",
  "id": "dr-1",
  "status": "final",
  "category": [ { "coding": [ { "system": "http://terminology.hl7.org/CodeSystem/v2-0074", "code": "LAB", "display": "Laboratory" } ] } ],
  "code": { "coding": [ { "system": "http://loinc.org", "code": "11502-2", "display": "Laboratory report" } ] },
  "subject": { "reference": "Patient/pat-1" },
  "effectiveDateTime": "2023-09-15",
  "issued": "2023-09-15T10:30:00Z",
  "performer": [ { "reference": "Organization/org-1", "display": "Someplace General Hospital" } ],
  "result": [ { "reference": "Observation/obs-1", "display": "Hemoglobin A1c" } ]
}`
  },

  Observation: {
    profile: [
      "http://hl7.org/fhir/uv/ips/StructureDefinition/Observation-results-laboratory-pathology-uv-ips",
      "http://hl7.org/fhir/uv/ips/StructureDefinition/Observation-results-radiology-uv-ips"
    ],
    requirements: [
      "subject: Reference(Patient)",
      "status: final | amended (as appropriate)",
      "category: laboratory | imaging (per profile)",
      "code: LOINC test/observation code (not LP Parts)",
      "For Observation.code (the question), prefer LOINC question codes (not LOINC Parts)",
      "effective[x]: observation time",
      "value[x]: Quantity (UCUM) or CodeableConcept as appropriate",
      "If value[x] is CodeableConcept (qualitative finding), prefer SNOMED CT values; use LOINC answer lists where the question binds to one",
      "interpretation: HL7 v3 ObservationInterpretation when applicable",
      "specimen: Reference(Specimen) for lab when applicable",
      "method/bodySite: optional; when used, prefer SNOMED CT",
    ],
    example: `{
  "resourceType": "Observation",
  "id": "obs-1",
  "status": "final",
  "category": [ { "coding": [ { "system": "http://terminology.hl7.org/CodeSystem/observation-category", "code": "laboratory", "display": "Laboratory" } ] } ],
  "code": { "coding": [ { "system": "http://loinc.org", "code": "17856-6", "display": "Hemoglobin A1c/Hemoglobin.total in Blood by HPLC" } ] },
  "subject": { "reference": "Patient/pat-1" },
  "effectiveDateTime": "2023-09-15T10:20:00Z",
  "valueQuantity": { "value": 7.5, "unit": "%", "system": "http://unitsofmeasure.org", "code": "%" },
  "note": [ { "text": "Above stated goal of 7.0 %" } ]
}`
  },

  Specimen: {
    profile: "http://hl7.org/fhir/uv/ips/StructureDefinition/Specimen-uv-ips",
    requirements: [
      "subject: Reference(Patient)",
      "type: CodeableConcept (SNOMED/HL7 where appropriate)",
      "receivedTime/collection: include when available",
    ],
    example: `{
  "resourceType": "Specimen",
  "id": "spec-1",
  "type": { "coding": [ { "system": "http://snomed.info/sct", "code": "122575003", "display": "Urine specimen" } ] },
  "subject": { "reference": "Patient/pat-1" },
  "collection": { "method": { "coding": [ { "system": "http://snomed.info/sct", "code": "73416001", "display": "Urine specimen collection, clean catch" } ] } }
}`
  },

  ImagingStudy: {
    profile: "http://hl7.org/fhir/uv/ips/StructureDefinition/ImagingStudy-uv-ips",
    requirements: [
      "subject: Reference(Patient)",
      "started: when available",
      "series/modality: include minimal series with modality",
    ],
    example: `{
  "resourceType": "ImagingStudy",
  "id": "img-1",
  "status": "available",
  "subject": { "reference": "Patient/pat-1" },
  "procedureCode": [ { "coding": [ { "system": "http://loinc.org", "code": "49569-7", "display": "SPECT Heart perfusion and wall motion" } ] } ],
  "series": [ {
    "uid": "2.16.840.1.113883.2.9.999.2.12345",
    "modality": { "system": "http://dicom.nema.org/resources/ontology/DCM", "code": "NM", "display": "Nuclear Medicine" },
    "bodySite": { "system": "http://snomed.info/sct", "code": "80891009", "display": "Heart" }
  } ]
}`
  },

  Medication: {
    profile: "http://hl7.org/fhir/uv/ips/StructureDefinition/Medication-uv-ips",
    requirements: [
      "code: RxNorm (ingredient or clinical drug as supported)",
      "form/ingredient: include when known",
    ],
    example: `{
  "resourceType": "Medication",
  "id": "med-1",
  "code": { "coding": [ { "system": "http://www.nlm.nih.gov/research/umls/rxnorm", "code": "757704", "display": "Simvastatin 40 MG Disintegrating Oral Tablet" } ], "text": "Simvastatin 40 MG Disintegrating Oral Tablet" },
  "form": { "coding": [ { "system": "http://www.nlm.nih.gov/research/umls/rxnorm", "code": "1294713", "display": "Disintegrating Oral Product" } ] },
  "ingredient": [ { "itemCodeableConcept": { "coding": [ { "system": "http://www.nlm.nih.gov/research/umls/rxnorm", "code": "36567", "display": "Simvastatin" } ] }, "strength": { "numerator": { "value": 40, "unit": "mg", "system": "http://unitsofmeasure.org", "code": "mg" }, "denominator": { "value": 1, "unit": "tablet", "system": "http://unitsofmeasure.org", "code": "1" } } } ]
}`
  },

  MedicationRequest: {
    profile: "http://hl7.org/fhir/uv/ips/StructureDefinition/MedicationRequest-uv-ips",
    requirements: [
      "intent: order",
      "status: active | completed | on-hold, etc.",
      "medication[x]: RxNorm (ingredient or clinical drug)",
      "subject: Reference(Patient)",
      "authoredOn/requester: include when known",
      "dosageInstruction: include route, dose, frequency when available",
    ],
    example: `{
  "resourceType": "MedicationRequest",
  "id": "medreq-1",
  "status": "active",
  "intent": "order",
  "medicationReference": { "reference": "Medication/med-1", "display": "simvastatin" },
  "subject": { "reference": "Patient/pat-1" },
  "authoredOn": "2023-09-15",
  "requester": { "reference": "Practitioner/pract-1" },
  "dosageInstruction": [ {
    "text": "40 mg/day",
    "timing": { "repeat": { "frequency": 1, "period": 1, "periodUnit": "d" } },
    "doseAndRate": [ { "doseQuantity": { "value": 40, "unit": "mg", "system": "http://unitsofmeasure.org", "code": "mg" } } ]
  } ]
}`
  },

  MedicationStatement: {
    profile: "http://hl7.org/fhir/uv/ips/StructureDefinition/MedicationStatement-uv-ips",
    requirements: [
      "status: active | completed, etc.",
      "medication[x]: RxNorm",
      "subject: Reference(Patient)",
      "effective[x]: when known",
      "dosage: optional; include if described",
    ],
    example: `{
  "resourceType": "MedicationStatement",
  "id": "medstmt-1",
  "status": "active",
  "medicationReference": { "reference": "Medication/med-1", "display": "simvastatin" },
  "subject": { "reference": "Patient/pat-1" },
  "effectivePeriod": { "start": "2021" },
  "dosage": [ {
    "text": "40 mg/day",
    "timing": { "repeat": { "frequency": 1, "period": 1, "periodUnit": "d" } },
    "doseAndRate": [ { "doseQuantity": { "value": 40, "unit": "mg", "system": "http://unitsofmeasure.org", "code": "mg" } } ]
  } ]
}`
  },

  Immunization: {
    profile: "http://hl7.org/fhir/uv/ips/StructureDefinition/Immunization-uv-ips",
    requirements: [
      "status: completed",
      "vaccineCode: CVX (preferred) or SNOMED CT",
      "patient: Reference(Patient)",
      "occurrenceDateTime: vaccination date",
      "primarySource: true when recorded from source",
    ],
    example: `{
  "resourceType": "Immunization",
  "id": "imm-1",
  "status": "completed",
  "vaccineCode": { "coding": [ { "system": "http://snomed.info/sct", "code": "871878002", "display": "DTP-Polio vaccine product" } ] },
  "patient": { "reference": "Patient/pat-1" },
  "occurrenceDateTime": "1998-06-04T00:00:00Z",
  "primarySource": true,
  "lotNumber": "AXK23RWERS"
}`
  },

  Device: {
    profile: "http://hl7.org/fhir/uv/ips/StructureDefinition/Device-uv-ips",
    requirements: [
      "identifier and/or distinct attributes (manufacturer/model)",
      "type: CodeableConcept",
    ],
    example: `{
  "resourceType": "Device",
  "id": "dev-1",
  "identifier": [ { "system": "http://my.org/devices", "value": "12345" } ],
  "manufacturer": "Acme Devices",
  "deviceName": [ { "name": "H.I.A. BEGIN", "type": "model-name" } ],
  "modelNumber": "2.0.1"
}`
  },

  DeviceUseStatement: {
    profile: "http://hl7.org/fhir/uv/ips/StructureDefinition/DeviceUseStatement-uv-ips",
    requirements: [
      "status: active | completed, etc.",
      "subject: Reference(Patient)",
      "device: Reference(Device)",
      "timing[x]/recordedOn: when available",
    ],
    example: `{
  "resourceType": "DeviceUseStatement",
  "id": "dus-1",
  "status": "active",
  "subject": { "reference": "Patient/pat-1" },
  "device": { "reference": "Device/dev-1" }
}`
  },

  Flag: {
    profile: "http://hl7.org/fhir/uv/ips/StructureDefinition/Flag-alert-uv-ips",
    requirements: [
      "status: active | inactive",
      "category: alert",
      "code: alert type",
      "subject: Reference(Patient)",
    ],
    example: `{
  "resourceType": "Flag",
  "id": "flag-1",
  "status": "active",
  "category": [ { "coding": [ { "system": "http://terminology.hl7.org/CodeSystem/flag-category", "code": "contact", "display": "Subject Contact" } ] } ],
  "code": { "coding": [ { "system": "http://snomed.info/sct", "code": "370388006", "display": "Patient immunocompromised (finding)" } ], "text": "Patient Immunocompromised" },
  "subject": { "reference": "Patient/pat-1" }
}`
  }
};
