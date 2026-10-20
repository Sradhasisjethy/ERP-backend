# DPDP Act compliance

These documents describe what the ERP does about the **Digital Personal Data Protection Act, 2023** (the Act) and the **Digital Personal Data Protection Rules, 2025** (the Rules). They also say which obligations the business has to meet itself.

They are written for three readers: the business owner, the lawyer who reviews them, and developers changing the system. Nothing here is legal advice. The lawful bases, the retention periods and the notice text are a well-reasoned starting point. A lawyer should confirm them before the notice is published.

## When the obligations apply

The Rules were notified on 13 November 2025 and come into force in stages:

| Rules | Subject | In force |
|---|---|---|
| 1, 2, 17-21 | Definitions, the Data Protection Board | On notification |
| 4 | Consent Managers | 12 months after notification |
| 3, 5-16, 22, 23 | Notice, security, breaches, retention, children, rights, transfers | **18 months after notification, about May 2027** |

Everything a Data Fiduciary has to do applies from about May 2027. That is the notice, security safeguards, breach reporting, erasure, the grievance contact, children's data and people's rights. Running the system this way before then means the evidence will already exist on the day the obligations start. Confirm the exact commencement dates against the Gazette.

## Who runs it

The privacy desk belongs to the **application owner**: the business that runs this ERP for the organisations that use it. There is one privacy notice, one privacy contact, one breach register and one retention schedule for the whole application. The owner answers every request, from every organisation.

An organisation's own administrators have no access to any of it. That includes `TENANT_OWNER` and `PLATFORM_ADMIN`, which pass every ordinary permission check. The owner's accounts are named on the server in `PLATFORM_OWNER_EMAILS`. Nothing inside the app can grant that.

Every user of every organisation keeps **My privacy**, for their own data.

**Contracts.** Each organisation decides why it holds its staff's, labour's and customers' data, so in the Act's terms it is usually the Data Fiduciary for that data, and the application owner processes it on its behalf. When the owner also runs the privacy desk for everyone, the contract with each organisation should say so: the owner publishes the notice, answers requests and reports breaches on the organisation's behalf. Have your lawyer write this into your terms of service.

## Who is who

| Act's term | In this system |
|---|---|
| Data Fiduciary | Each organisation using the ERP, for its own people's data. The application owner, for its own data and for the desk it runs on the organisations' behalf (see the contract note above). |
| Data Principal | Anyone whose personal data is held: staff (`employees`), labour, contractors, customers and vendors who are individuals (`parties`), enquirers (`leads`), drivers. |
| Data Processor | Services that process data for the business: hosting, the database host, and email delivery (Brevo). They are listed in the notice. |
| Board | The Data Protection Board of India. It receives breach reports and complaints. |

## What the system provides

| Obligation | Where |
|---|---|
| Notice (s.5, Rule 3) | Data Protection > Notice & contact. The notice is versioned, a published version is frozen, and staff are asked to read each new version on sign-in. |
| Contact for questions (s.8(9), Rule 9) | The privacy contact on the same tab. It is shown on the notice, the public page, the self-service card and every breach notice. |
| Consent and its withdrawal (s.6) | The consent register. Every consent is tied to a purpose, a notice version and the organisation holding the person's record. Withdrawing is one click, for the person in My privacy or for the owner on the register. |
| Legitimate uses (s.7) | Each purpose in the notice declares its basis. Consent cannot be recorded for a purpose that does not need it. |
| Rights: access, correction, erasure, grievance, nomination (s.11-14, Rule 14) | Staff use My Profile > My privacy. Everyone else uses the public page at `/privacy`, which the login page's "Privacy Policy" link opens. The owner handles every request under Data Protection > Requests: matching it to the organisation and record, checking identity, and keeping to the due date. |
| Erasure when the purpose is spent (s.8(7), Rule 8) | Data Protection > Retention. The rules start switched off and run nightly once switched on. |
| Breach reporting (s.8(6), Rule 7) | Data Protection > Breaches. Each breach shows a 72-hour clock and drafts of the Board report and the notice to affected people. It cannot be closed until every step is recorded. |
| Children (s.9, Rule 10) | Consent for a party under 18 needs a verified guardian. The overview lists minors who have no guardian consent. |
| Security safeguards and logs (s.8(5), Rule 6) | Identity and bank masking, role-based access, an audit trail on every change, and access exports logged. The audit trail is never purged within a year. |

How each one maps to the law, section by section: [compliance-mapping.md](compliance-mapping.md).

## The documents

- [compliance-mapping.md](compliance-mapping.md): each section and rule, what the system does, and what the business must do.
- [records-of-processing.md](records-of-processing.md): what personal data is held, where, why, and for how long.
- [privacy-notice-draft.md](privacy-notice-draft.md): the full privacy policy to adapt and publish.
- [breach-response-runbook.md](breach-response-runbook.md): what to do, hour by hour, when something goes wrong.
- [dpia-template.md](dpia-template.md): a Data Protection Impact Assessment. Only a Significant Data Fiduciary must do one, but it is a good discipline before any new use of personal data.

## Switching it on

1. Run the migrations: `npm run migrate`. This adds the privacy tables, the `erasedAt` columns and two notification types.
2. Set `PLATFORM_OWNER_EMAILS` on the server (for example on Render) to your own account's email. Separate several with commas. Restart the server.
3. Sign in with that account. **Data Protection** appears in the menu. Open **Notice & contact**:
   1. Fill in the privacy contact.
   2. Start a notice from the template and edit it with [privacy-notice-draft.md](privacy-notice-draft.md) beside you.
   3. Publish it.

   The login page's "Privacy Policy" link now opens it, for everyone.
4. Review the retention periods with your lawyer and switch on the rules you agree with.

## For developers

- The code is in `src/api/privacy/`. The migration is `src/migrations/20261014000000-dpdp-privacy.js` and the tests are in `tests/dpdp-privacy.test.js`.
- **Adding personal data to a model?** Add it in three places:
  1. The erasure field lists in `erasure.service.js`.
  2. `AUDIT_PERSONAL_KEYS` in the same file.
  3. The inventory in [records-of-processing.md](records-of-processing.md).

  A field missing from the first two survives an erasure, in the record or in the audit trail.
- **The desk runs with no organisation in context.** Reads span every organisation. Anything that reads or writes one organisation's records goes through `asTenant` (`src/core/platformOwner.js`), so the scoped models and the audit trail behave as they do everywhere else. `platformContext` sets the tenant to null explicitly, because a new CLS session would otherwise inherit whatever an earlier request left behind.
- **Adding a new kind of person?** For example, drivers as a principal type. Add an eraser and a `compilePersonalData` branch, and a retention finder if the data expires.
- **Never update a record being erased through the audit hooks.** An ordinary `update()` copies every erased value into `beforeSnapshot`. `erasure.service.js` explains this further.
