# DPDP Act and Rules: section-by-section mapping

The table below goes through each obligation the Act places on a Data Fiduciary, with the Rule that details it. For each one it says what the ERP does and what the business must still do. It is not legal advice. A lawyer should confirm each "Business must" line.

**Column meanings:**
- **System** is what the code does, and where.
- **Business must** is what software cannot do on the business's behalf.

## Chapter II: obligations of a Data Fiduciary

### s.4: Grounds for processing

> Personal data may be processed only for a lawful purpose, with consent or for a legitimate use.

- **System:** every purpose in the notice declares `lawfulBasis`: `CONSENT` or `LEGITIMATE_USE` with a legal reference. The consent register refuses consent for a legitimate-use purpose, and refuses any purpose that is not in the published notice.
- **Business must:** decide the basis for each purpose. The starter notice proposes these:
  - employment, labour, billing and payments rest on legitimate use, s.7(a) and s.7(i);
  - following up an enquiry and marketing rest on consent.

### s.5 and Rule 3: Notice

> Every request for consent comes with a notice. Where processing began before the Act, the notice is given as soon as reasonably practicable. The notice must be understandable on its own, in clear and plain language. It must give an itemised description of the personal data and the specified purpose, and the means to withdraw consent, exercise rights and complain to the Board. It must be available in English or any language in the Eighth Schedule.

- **System:**
  - `privacy_notices` holds versioned notices. Each one has itemised purposes, the data items for each, its basis, its retention period and its processors.
  - A published notice can never be edited; a change means a new version.
  - The notice is shown in four places:
    - to every user on sign-in, until they acknowledge that version;
    - on My Profile;
    - on the public page `/privacy`, which the login page links to;
    - in each person's data export.
  - Each consent records the notice version it was given under.
- **Business must:**
  - Write the notice in plain words, using [privacy-notice-draft.md](privacy-notice-draft.md).
  - Publish versions in the languages your people read, for example Odia and Hindi as well as English. The `language` field supports this, but only one notice is in force at a time. Until there is per-language support, provide the translations on paper.
  - Give the notice to people who never sign in:
    - labourers, by a printed copy at the gate or on joining;
    - walk-in customers, by the public link on the invoice or a printed copy.

### s.6: Consent

> Consent must be free, specific, informed, unconditional and unambiguous, given by a clear affirmative action, and limited to what the purpose needs. It must be as easy to withdraw as to give. On withdrawal, processing stops within a reasonable time, unless the law requires otherwise.

- **System:**
  - `consent_records` stores one row per purpose per person. Each row records how consent was given (method), the evidence, who captured it, the IP address and the notice version.
  - Withdrawal is one action, for the person in My privacy or for the officer in the register or on the lead.
  - When a lead withdraws its last consent, an erasure request opens automatically, because s.6(6) and s.8(7)(a) apply.
  - Only optional, consent-based purposes are offered as switches, so consent is never bundled with employment.
- **Business must:**
  - Not make anything conditional on consent to an optional purpose. For example, do not refuse to sell to someone who declines marketing.
  - Keep paper consent forms where the evidence field says they are.

### s.7: Legitimate uses

> Processing without consent is allowed for listed uses. These include data the person provided voluntarily for a specified purpose, s.7(a), and employment purposes, s.7(i).

- **System:**
  - The starter notice marks employment, security logs, labour engagement, orders and billing, and supplier payments as legitimate uses.
  - The notice is still shown, and staff acknowledge it.
- **Business must:**
  - Confirm each legitimate-use claim with counsel. s.7(a) only covers data the person supplied *for that purpose* and did not object to.

### s.8(1)-(4): General obligations

> The Fiduciary stays responsible for processing done by its processors. Data must be complete, accurate and consistent where it is used for decisions or disclosed.

- **System:**
  - Processors are listed in the notice.
  - Correction requests go through the requests queue.
  - The ordinary edit screens make the correction, and the audit trail records it.
- **Business must:**
  - Have a written contract with each processor: hosting, database, email.
  - Fill in each processor's real location in the notice. The template says "To be confirmed".

### s.8(5) and Rule 6: Security safeguards

> Reasonable security safeguards are required, including:
> - encryption, obfuscation, masking or tokens;
> - access control;
> - visibility of access through logs, monitoring and review;
> - backups so processing can continue after a compromise;
> - keeping those logs for a year;
> - contracts with processors;
> - technical and organisational measures.

- **System:**
  - Role-based access with separate grants for sensitive actions.
  - Aadhaar, PAN, bank, ESIC/UAN, date of birth and emergency contact are masked unless the user holds `PARTY_SENSITIVE_READ`, and are kept out of the audit trail.
  - Every create, update, delete, erasure and personal-data export is recorded with user, time and IP.
  - Personal-data fields are redacted from application logs.
  - Query strings are dropped from access logs.
  - The audit trail is never purged; at most, personal values inside snapshots older than the period are masked, and never within 365 days.
  - The compliance overview reports whether the database connection is encrypted.
- **Business must:**
  - Take backups and test a restore.
  - Run the database with TLS.
  - Restrict network access to the database.
  - Review access logs periodically.
  - Train staff on handling personal data.
  - The private gap register in `brain/security/` lists what is still open.

### s.8(6) and Rule 7: Breach intimation

> On becoming aware of a personal data breach, the Fiduciary must:
> - tell each affected person without delay, covering what happened, the likely consequences, the mitigation, what they can do, and a contact;
> - tell the Board without delay;
> - send the Board a detailed report within 72 hours, covering the facts, the mitigation, findings about who caused it, the measures against recurrence, and the intimations sent.
>
> There is no harm threshold.

- **System:**
  - `data_breaches` is the breach register.
  - The 72-hour deadline is computed from `discoveredAt`, the moment of awareness, not from when someone logged the breach.
  - The steps recorded are: contained, Board intimated, report submitted (with the Board's reference), and affected people told (with the method).
  - A breach cannot be closed until all four steps are recorded.
  - The system drafts both texts from the register.
  - A nightly CRITICAL alert fires when a report is due within 24 hours or is late.
- **Business must:**
  - Send the drafts through the Board's portal and your own channels. The system does not send them.
  - Follow [breach-response-runbook.md](breach-response-runbook.md).

### s.8(7) and Rule 8: Erasure

> Personal data is erased when consent is withdrawn or the purpose is no longer served, unless the law requires keeping it. The Third Schedule's fixed periods and the 48-hour pre-erasure warning apply only to large e-commerce, gaming and social-media platforms, so this ERP is not one of them. Rule 8(3) requires personal data, traffic data and logs to be kept for at least one year.

- **System:**
  - `ErasureService` wipes personal fields in place.
  - It keeps what tax, GST and wage law require: name, GSTIN, state, the invoices and the wages.
  - It masks the same fields in earlier audit snapshots.
  - It deletes documents and avatars.
  - It records one `ERASE` audit row naming the fields, never the values.
  - Retention rules cover:
    - lost leads and dormant leads;
    - inactive labour;
    - inactive individual customers;
    - former employees;
    - personal values in old audit snapshots.
  - Every rule starts switched off and has a minimum period of at least 365 days for logs.
- **Business must:**
  - Agree the periods with counsel. The defaults are:
    - 1 year for lost leads;
    - 2 years for dormant leads;
    - 3 years for labour;
    - 8 years for customers and former employees.
  - Switch on the rules you agree with.
  - Remember that GST records must be kept for 72 months from the due date of the annual return (CGST Act s.36). Books of account must be kept for 8 years (Companies Act s.128).

### s.8(9) and Rule 9: Contact for questions

> Publish the business contact information of the DPO, or of a person who can answer questions about processing, on the website or app and in every response to a person.

- **System:**
  - The privacy profile holds the name, designation, email, phone and postal address.
  - A notice cannot be published until a contact email exists.
  - The contact appears on the notice, the public page, My privacy, data exports and breach notices.
- **Business must:**
  - Name a real person and keep the contact details current.

### s.8(10): Grievance redressal

- **System:**
  - The request type `GRIEVANCE` covers this, with a due date set from the published response time.
  - The response time is capped at the 90 days Rule 14(3) allows.
  - A nightly alert fires on each overdue request.
- **Business must:**
  - Answer within the published time.
  - Tell the person they can complain to the Board if they are not satisfied.

### s.9 and Rule 10: Children

> A child is anyone under 18. Processing a child's data needs verifiable consent from a parent or lawful guardian. No tracking, behavioural monitoring or targeted advertising directed at children is allowed.

- **System:**
  - Consent for a party whose date of birth makes them under 18 is refused unless a guardian and the verification method are recorded.
  - The overview lists every under-18 record without such consent.
- **Business must:**
  - Check the law before engaging anyone under 18. The Child and Adolescent Labour Act bars adolescents from hazardous processes, and a precast plant is likely to count as one.
  - Verify guardians properly, for example by seeing the parent's identity document in person.

### s.10 and Rule 13: Significant Data Fiduciary

> A business the Government notifies as a Significant Data Fiduciary must appoint a DPO based in India and an independent auditor, and carry out an annual DPIA and audit.

- **System:**
  - A flag in the privacy profile records whether the business has been notified.
  - [dpia-template.md](dpia-template.md) supports the DPIA.
- **Business must:**
  - Act on this only if the business is notified, which is unlikely for a single manufacturer.

## Chapter III: rights of the Data Principal

### s.11: Right to information

> A summary of the personal data held and the processing done, the other Fiduciaries and Processors it was shared with, and any other information prescribed.

- **System:** `compilePersonalData` produces a JSON download containing:
  - the person's own fields, unmasked, because it is their data;
  - related records;
  - the purposes that apply to them;
  - the processors;
  - their consents and nominee;
  - the contact.

  Staff download it themselves. For anyone else, the owner releases it only after verifying identity. Every export is logged in that organisation's audit trail.
- **Business must:**
  - Verify identity before releasing data.
  - Send the file securely, for example on paper in person or a password-protected file.

### s.12: Correction, completion, updating, erasure

- **System:**
  - Correction and updating are request types. The edit happens on the record's own screen.
  - Erasure is carried out by the owner completing the request. It needs a verified identity and a confirmation.
- **Business must:**
  - Explain any refusal, for example "we must keep the invoice for GST".

### s.13: Grievance redressal

Covered under s.8(10) above.

### s.14: Nomination

> A person may nominate someone to exercise their rights after death or incapacity.

- **System:**
  - Staff name a nominee in My privacy.
  - Others do it through a NOMINATION request, which the officer completes with the nominee's details.
  - Only one nominee is active per person; replacing them revokes the old one.
- **Business must:**
  - When a nominee makes a request, verify both the nominee and the death or incapacity.

### s.15: Duties of the Data Principal

No system change. A request may be rejected if it is frivolous or gives false particulars, with the reason recorded.

## Other provisions

| Provision | System | Business must |
|---|---|---|
| s.16: transfer outside India (allowed except to countries the Government restricts) | The "Where the data is stored" field and each processor's location are shown publicly. | Record where each processor stores data, and check the Government's restricted list when it is published. |
| s.17: exemptions | None needed. | None. |
| Rule 4: Consent Managers | Not used. Consent is collected directly. | None, unless you choose to use a registered Consent Manager. |
| Rule 22 / Seventh Schedule: information requested by the Government | The audit trail and exports support this. | Respond to lawful requests. |
| Penalties (Schedule) | — | Up to ₹250 crore for failing to take reasonable security safeguards. Up to ₹200 crore each for failing to report a breach and for breaching the children's obligations. Up to ₹50 crore for other breaches. |

## Who can do what

| Who | Can |
|---|---|
| The application owner (accounts in `PLATFORM_OWNER_EMAILS` on the server) | Everything under Data Protection, across every organisation: notice and contact, requests, consent register, breaches, retention, and exports of one person's data |
| An organisation's administrators (`TENANT_OWNER`, `PLATFORM_ADMIN`, any role) | Nothing under Data Protection. There are no permissions for it to grant. |
| Every signed-in user | My privacy: read the notice, switch optional consents, download their own data, make requests, name a nominee |
| Anyone, signed in or not | Read the notice at `/privacy` and make a request |

The owner's access is not a permission. The ordinary permission check lets `TENANT_OWNER` and `PLATFORM_ADMIN` through everything, and those are the organisations' own administrators. Changing who the owner is takes a change to the server's configuration.

Overdue requests and breach deadlines reach the owner as personal notifications. They are never broadcast to an organisation's staff.
