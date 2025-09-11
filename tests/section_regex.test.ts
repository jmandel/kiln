import { describe, expect, test } from "bun:test";
import { H2_SECTION_REGEX as SECTION_REGEX, extractSections, renderSectionNarrative, canonicalizeHeader } from "../src/sections";

function stitchPlaceholder(sectionTitle: string, noteText: string): string {
  return renderSectionNarrative(noteText, sectionTitle) || '';
}

// Note content from the example (abbreviated only by removing trailing spaces); keep headings exact.
const NOTE = `## Chief Complaint
The patient is a 52-year-old male professional mime who presents to the clinic today accompanied by his wife, reporting acute onset of left-sided facial weakness and drooping that has progressively worsened over the past two days, significantly impairing his ability to perform expressive facial gestures central to his livelihood.

## History of Present Illness
The patient is a 52-year-old right-handed male who works professionally as a mime, presenting with acute left-sided facial weakness that began two days ago. He describes the onset as subtle during an outdoor street performance, initially noticing difficulty raising his left eyebrow and subtle asymmetry in his smile while attempting to convey emotions to passersby. Over the subsequent hours, this progressed to noticeable drooping of the left corner of his mouth, inability to fully close his left eye, and a sensation of heaviness on the left side of his face. He reports no preceding viral illness, ear pain, or trauma, though he mentions recent exposure to variable weather during performances in urban parks. The weakness is isolated to the face, with no associated limb weakness, sensory changes, or speech difficulties beyond the facial asymmetry. His wife notes that he has been attempting to communicate non-verbally at home, but the impaired expressions have led to frustration and mild sleep disruption due to eye irritation from incomplete closure. He denies headache, vision changes, or other neurological symptoms.

## Past Medical History
The patient is a 52-year-old male with a past medical history significant for hypertension, diagnosed five years ago during a routine physical examination prompted by mild headaches and elevated blood pressure readings. He has been managed with lifestyle modifications and lisinopril 20 mg daily, with good control until recently when readings have trended higher, possibly exacerbated by performance-related stress. He also reports a history of seasonal allergies, treated with over-the-counter antihistamines, and denies diabetes, hyperlipidemia, smoking history, or prior neurological events. No surgical history or current medications beyond lisinopril and occasional ibuprofen for minor strains from repetitive miming postures.

## Social History
The patient is a 52-year-old male who has worked as a professional mime for over 25 years, specializing in street performances and theatrical productions across urban centers in the United States. His career involves prolonged outdoor exposures to elements like wind, sun, and crowds, as well as repetitive facial and postural strains to maintain silent, exaggerated expressions. He lives with his wife in a suburban home, denies alcohol or tobacco use, and exercises moderately through daily walks and performance rehearsals. This occupational history likely influences his symptom reporting, as the facial weakness directly hampers his non-verbal artistry, heightening his concern over potential long-term impacts on his income and identity.

## Review of Systems
The patient denies constitutional symptoms including fever, chills, night sweats, unintentional weight loss, or fatigue beyond that attributable to disrupted sleep from facial discomfort. He gestures emphatically to indicate no ear pain, hearing loss, or tinnitus on the affected side, and no neck stiffness or rash. Cardiovascular review is negative for chest pain or palpitations, though he acknowledges his known hypertension. Respiratory, gastrointestinal, genitourinary, musculoskeletal, and dermatologic systems are reviewed as negative, with the exception of mild left facial tingling that he mimes by tracing his cheek. Neurologically, beyond the chief complaint, he denies vertigo, dysphagia, or extremity symptoms, communicating these denials through exaggerated head shakes and hand signals to compensate for his facial limitations.

## Physical Examination
**Vital signs:** Blood pressure 142/88 mmHg, heart rate 76 beats per minute and regular, respiratory rate 14 breaths per minute, temperature 98.6°F orally, oxygen saturation 98% on room air.

**General:** Well-appearing, alert, and oriented, though visibly frustrated, relying on animated hand gestures and his wife's translations for emphasis.

**HEENT:** Pupils equal, round, and reactive to light; extraocular movements intact. Left eyelid droops with incomplete closure on gentle closure attempt (Bell's phenomenon present), left nasolabial fold flattened at rest, and inability to puff left cheek or smile symmetrically. No oral lesions, thyromegaly, or cervical lymphadenopathy. Hearing grossly intact bilaterally.

**Neck:** Supple, no bruits.

**Cardiovascular:** Regular rate and rhythm, no murmurs.

**Pulmonary:** Clear to auscultation bilaterally.

**Abdomen:** Soft, nontender, nondistended.

**Extremities:** No edema, full strength and sensation.

**Neurologic:** Cranial nerves: I intact (coffee grounds identified); II intact; III, IV, VI intact; V intact bilaterally (corneal reflex diminished on left due to VII); VII as described with left lower motor neuron pattern; VIII intact; IX, X intact (gag reflex symmetric); XI intact (shoulder shrug equal); XII intact (tongue midline). Mental status alert and oriented x3; no ataxia; gait normal. Building on the history of isolated facial involvement, the exam confirms a peripheral seventh nerve palsy without central signs.

## Assessment
This 52-year-old right-handed male professional mime presents with acute, isolated left-sided facial nerve (cranial nerve VII) palsy of two days' duration, characterized by progressive drooping of the left eyelid and mouth, consistent with Bell's palsy. The diagnosis is supported by the lower motor neuron pattern on exam, absence of other neurological deficits, and lack of vesicles or trauma suggesting alternative etiologies like Ramsay Hunt syndrome or stroke. Differentials include Lyme disease given outdoor exposures in endemic areas, though no tick bite or systemic symptoms; sarcoidosis or malignancy are less likely in this age group without comorbidities. His hypertension is a minor risk factor for vascular events, but the isolated presentation favors idiopathic neuritis. Occupational repetitive strain may contribute to nerve vulnerability, underscoring the ironic impact on his mime career reliant on facial expressivity. Early intervention is key, as evidence supports improved recovery with steroids in adults over 40.

## Plan
### Medical Management
1. Initiate oral prednisone 60 mg daily for 5 days, followed by a taper (40 mg for 5 days, then 20 mg for 5 days, then 10 mg for 5 days) to reduce facial nerve inflammation and edema, based on guidelines showing better outcomes in this age group. Monitor for side effects like hyperglycemia or insomnia; follow up in 1 week to assess response.

### Supportive Care
2. Prescribe artificial tears and lubricating ointment for left eye protection to prevent corneal abrasion from lagophthalmos; advise taping eyelid shut at night and wearing protective eyewear during performances. Recommend gentle facial exercises starting after 72 hours to maintain muscle tone without strain.

### Diagnostics and Follow-Up
3. Serologic testing for Lyme disease (ELISA and Western blot) given occupational outdoor risks; consider viral serologies if no improvement. No imaging indicated acutely, but MRI of brainstem if atypical features emerge. Schedule neurology consult if incomplete recovery by 3 months. Optimize hypertension management with lisinopril dose review.

### Counseling
4. Educated patient and wife on Bell's palsy prognosis: 70-80% full recovery within 3-6 months, with prompt treatment favoring good outcome despite his age over 40. Discussed emotional impact on livelihood, encouraging adaptive non-facial mime techniques temporarily; provided resources for support groups. Return precautions include worsening weakness, new headaches, or fever.
`;

describe('Section extraction regex', () => {
  test('captures all H2 sections and titles (LF)', () => {
    const sections = extractSections(NOTE);
    // Expect the classic 8 H2 sections
    const expected = [
      'Chief Complaint',
      'History of Present Illness',
      'Past Medical History',
      'Social History',
      'Review of Systems',
      'Physical Examination',
      'Assessment',
      'Plan',
    ];
    for (const t of expected) {
      expect(sections.has(canonicalizeHeader(t))).toBe(true);
    }
  });

  test('captures full Physical Examination body (LF)', () => {
    const sections = extractSections(NOTE);
    const phys = sections.get(canonicalizeHeader('Physical Examination')) || '';
    // Sanity: multiple paragraphs captured
    expect(phys.split(/\n/).length).toBeGreaterThan(10);
    // Contains lines far beyond the first paragraph
    expect(phys).toContain('**Pulmonary:** Clear to auscultation bilaterally.');
    expect(phys).toContain('**Neurologic:** Cranial nerves: I intact');
  });

  test('captures full Physical Examination body (CRLF)', () => {
    const crlf = NOTE.replace(/\n/g, '\r\n');
    const sections = extractSections(crlf);
    const phys = sections.get(canonicalizeHeader('Physical Examination')) || '';
    expect(phys.split(/\n/).length).toBeGreaterThan(10);
    expect(phys).toContain('**Abdomen:** Soft, nontender, nondistended.');
  });
});

describe('Placeholder stitching', () => {
  test('replaces <div>{{Title}}</div> with full XHTML narrative', () => {
    const stitched = stitchPlaceholder('Physical Examination', NOTE);
    expect(stitched.startsWith('<div xmlns="http://www.w3.org/1999/xhtml">')).toBe(true);
    expect(stitched).toContain('<br/>'); // newline conversion
    // Vital signs at start and Neurologic near end ensure full span
    expect(stitched).toContain('**Vital signs:** Blood pressure 142/88');
    expect(stitched).toContain('**Neurologic:** Cranial nerves: I intact');
    // Ensure no stray HTML in content besides <br/>
    const inner = stitched.replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '');
    expect(/<(?!br\/?)/i.test(inner)).toBe(false);
  });

  test('replaces {{Title}} (no surrounding div) with full XHTML narrative', () => {
    const stitched = stitchPlaceholder('Past Medical History', NOTE);
    expect(stitched.startsWith('<div xmlns="http://www.w3.org/1999/xhtml">')).toBe(true);
    expect(stitched).toContain('past medical history significant for hypertension');
  });
});
