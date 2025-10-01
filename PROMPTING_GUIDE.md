# Kiln Prompting Guide

## What Kiln Does

Kiln transforms brief patient descriptions (**sketches**) into complete, realistic clinical notes with FHIR-structured data. You provide the key facts; Kiln's AI fills in the details to create plausible clinical documentation.

---

## Getting Started: Choose Your Mode

When you create a new job in Kiln, you'll select one of two modes from the top bar:

### **Narrative Mode** → Single Clinical Note
Use this for one patient encounter. You'll get one complete note.

### **Trajectory Mode** → Series of Notes Over Time
Use this for a patient journey across multiple visits. You'll get multiple episodes, each with its own note.

---

## Narrative Mode (Single Note)

### What to provide:
A sketch describing the patient and this one encounter.

### Examples:

**Minimal**:
```
52F with chest pain x2 weeks, worse with exertion; HTN and ex-smoker
```

**More detailed**:
```
52F presenting to cardiology with substernal chest pain for 2 weeks,
occurs with climbing stairs, lasts 5-10 min, relieved by rest. History
of hypertension on lisinopril, 40 pack-year smoking history (quit 5y ago).
```

Both work. The first gives Kiln freedom; the second ensures specific details appear.

### What Kiln fills in:
- Complete history of present illness
- Review of systems
- Physical exam findings (vitals, exam details)
- Realistic lab values when needed
- Assessment with clinical reasoning
- Evidence-based management plan
- Appropriate medical coding

---

## Trajectory Mode (Multiple Notes)

### What to provide:

1. **Basic patient sketch**: Demographics and core condition(s)
2. **Which notes to write**: Specify the clinical encounters you want documented
3. **Perspective/specialty**: Who is writing each note (optional but helpful)
4. **Important details**: Key events or findings for specific visits (optional)

### Template:
```
[Patient demographics and conditions]

Notes to write:
1. [Visit type/timepoint] - [any key details]
2. [Visit type/timepoint] - [any key details]
3. [Visit type/timepoint] - [any key details]
...
```

### Examples:

**Directing the trajectory** (recommended):
```
45M with type 2 diabetes and hypertension, developed diabetic nephropathy
leading to ESRD, received deceased-donor kidney transplant

Notes to write:
1. Nephrology consult for rising creatinine (2019)
2. Dialysis initiation visit (2020)
3. Transplant evaluation and listing (2021)
4. Hospital discharge after transplant surgery (2023, POD7)
5. 3-month post-transplant follow-up (stable graft function)
```

**Specifying perspectives**:
```
8M with asthma

Notes to write:
1. Initial diagnosis visit - pediatrician (age 5)
2. Routine follow-up - pediatrician (age 6, well-controlled)
3. ED visit for exacerbation (age 7, after viral URI)
4. Pulmonology consult (age 8, for treatment escalation)
```

**Including important details**:
```
63F with breast cancer

Notes to write:
1. Diagnostic visit - oncology (new stage II diagnosis, plan surgery)
2. Pre-chemo visit - oncology (s/p lumpectomy, path shows ER+/PR+/HER2-, start AC-T)
3. Mid-treatment visit - oncology (after 3/6 cycles, managing fatigue and neuropathy)
4. Radiation planning - radiation oncology (chemo complete, normal echo)
```

**Minimal trajectory** (Kiln decides the visits):
```
Patient with hypertension diagnosed 2020, well-controlled until AKI
hospitalization 2023, now recovering with nephrology
```
→ Kiln will create 3-4 episodes it thinks make sense

---

## How Much Detail to Include

### You're the Director

**Think of it like directing a play**: You can provide as much or as little direction as you want.

- **Minimal direction**: Give basic scenario, let Kiln decide all details
- **Moderate direction**: Specify which visits, general timeframes
- **Detailed direction**: Specify visits, specialties, key events, important findings

**All approaches work.** More detail = more control over the output.

### What to specify when it matters to you:

- **Demographics**: Age, sex
- **Key diagnoses**: Primary conditions
- **Medications**: If specific drugs are important
- **Timeline**: Dates or relative timeframes
- **Visit types**: Routine follow-up, ED visit, hospital admission, specialty consult
- **Specialty/perspective**: Who's writing the note (PCP, cardiologist, etc.)
- **Critical events**: Procedures, complications, test results that must appear
- **Important findings**: Labs, vitals, or exam findings you want documented

### What Kiln will fill in if you don't specify:

- Realistic exam findings
- Plausible lab values
- Appropriate medication doses
- Clinical reasoning
- Documentation details (vitals, ROS, etc.)
- Logical progression between visits

---

## Examples with Different Detail Levels

### Single Note: Minimal
```
74M with glaucoma, routine visit
```
→ Kiln creates complete ophthalmology note with IOP check, meds, exam, plan

### Single Note: Detailed
```
74M with primary open-angle glaucoma diagnosed 5 years ago, on latanoprost
0.005% qhs OU and Cosopt bid OU with good IOP control (baseline 24/22, now
15/14 mmHg). Presenting for routine 6-month follow-up. Include cup-disc
ratio 0.7 OU stable from prior, visual fields full.
```
→ Kiln uses these specifics and fills in the rest

### Trajectory: Minimal
```
Patient with diabetes, developed kidney disease, now on dialysis
```
→ Kiln creates 3-4 episodes showing progression

### Trajectory: Moderate Direction
```
58F with type 2 diabetes diagnosed 2015

Notes to write:
1. Initial diabetes diagnosis visit (2015)
2. Nephrology referral for elevated creatinine (2020)
3. Dialysis initiation (2022)
4. Current management visit (2024)
```
→ Kiln fills in details for each visit, maintains continuity

### Trajectory: Detailed Direction
```
58F with type 2 diabetes diagnosed 2015, initially A1c 9.2%

Notes to write:
1. PCP visit (2015) - new T2DM diagnosis, start metformin, lifestyle counseling
2. PCP follow-up (2018) - stable A1c 6.8%, creatinine now 1.4 (was 0.9), refer nephrology
3. Nephrology consult (2020) - CKD stage 3, eGFR 45, start lisinopril and SGLT2i
4. Nephrology follow-up (2022) - eGFR declining to 18, pre-dialysis education, create AV fistula
5. Dialysis center (2023) - HD initiation, tolerating well, start EPO for anemia
```
→ Kiln uses all these specifics and expands each visit into a complete note

---

## Tips for Great Sketches

### ✅ Do:

- **Use medical abbreviations**: HTN, T2DM, s/p, POD7, qhs, bid, etc.
- **Include timeframes**: x2 weeks, since 2020, POD7, age 5 to age 8
- **Specify what matters**: If a specific med, test result, or event is critical to your learning goal, include it
- **For trajectories**: List out the notes you want, even if just brief descriptions
- **Mix minimal and detailed**: Some visits can be vague ("routine follow-up") while others are detailed ("ED visit for chest pain, troponin 0.8, admitted for NSTEMI")

### ❌ Don't:

- **Write the whole note in your sketch**: You're providing seeds, not scripts
- **Include contradictions**: "diagnosed 2020, on treatment since 2019"
- **Over-specify unless needed**: Let Kiln fill in realistic details

### When in doubt:

Start with a **moderate level of direction** for trajectories: list the visits you want, mention key events, let Kiln handle the rest. You can always regenerate with more detail if needed.

---

## How Kiln Expands Your Sketch

**Your input** (Narrative Mode):
```
52F with chest pain x2 weeks, worse with exertion; HTN, ex-smoker
```

**Kiln generates**:
- **Chief Complaint**: New-onset exertional substernal chest pain
- **HPI**: Pressure-like quality, radiates to jaw, 5-10 min duration, relieved by rest, no SOB or diaphoresis
- **PMH**: HTN on lisinopril 10mg daily x15 years, 40 pack-year smoking (quit 5y ago)
- **Exam**: BP 148/82, HR 78, normal cardiac auscultation, no edema
- **Assessment**: Likely stable angina, high Framingham risk score
- **Plan**: ECG today, stress test within 1 week, start ASA 81mg and atorvastatin 40mg, cardiology referral, smoking cessation reinforcement

---

**Your input** (Trajectory Mode):
```
50M with HTN diagnosed 2020

Notes to write:
1. Initial diagnosis visit
2. Follow-up showing good control
3. Hospital admission for AKI (2023)
4. Recovery visit with nephrology
```

**Kiln generates 4 notes**:

1. **Note 1** (2020): New HTN diagnosis, BP 158/94, start lisinopril 10mg, lifestyle counseling
2. **Note 2** (2021): Routine follow-up, BP 128/78 on lisinopril, labs normal, continue current management
3. **Note 3** (2023): Hospital admission for AKI (creatinine 3.2 from baseline 0.9), dehydration + NSAIDs, hold lisinopril, IV fluids, nephrology consult
4. **Note 4** (3 months post-AKI): Nephrology follow-up, creatinine improved to 1.4 (stable CKD 3a), restart lisinopril 5mg, close monitoring plan

Each note references prior visits and shows realistic clinical progression.

---

## Quick Reference

| Mode | You Provide | Kiln Creates |
|------|-------------|--------------|
| **Narrative** | Sketch of one encounter | One complete note |
| **Trajectory** | Patient + list of visits to document | Multiple notes with continuity |

### Narrative Mode:
- Select "Narrative" from top bar
- Write sketch describing the patient and this visit
- Add as much or as little detail as you want
- Generate

### Trajectory Mode:
- Select "Trajectory" from top bar
- Write patient sketch
- List the notes you want (with timepoints, specialties, key events)
- Add details for visits where specific content matters
- Generate

---

## Remember

**You are the director.** Specify what matters to your learning goals, and let Kiln fill in realistic clinical details to make a plausible story.

- Want creative freedom? → Minimal sketch
- Want specific content? → Direct it in your sketch
- Want something in between? → Specify key visits and events, let Kiln handle details

**Start somewhere, iterate if needed.** If Kiln's output doesn't match your intent, add more direction to your sketch and regenerate.

---

**Last updated**: 2025-09-30
