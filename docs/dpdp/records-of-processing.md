# Records of processing: personal data in the ERP

This page lists what personal data the system holds, about whom, where it is stored, why, and what happens to it at the end of its period. Keep it current: a field that is not listed here is easy to forget at erasure time.

The basis column uses these short forms:
- **LU (s.7(a))**: data the person provided for this purpose.
- **LU (s.7(i))**: employment purposes.
- **C**: consent.
- **Law**: a statutory duty to keep the data.

## Staff (`employees`, `employee_documents`, `leave_requests`, `staff_attendance`, `refresh_tokens`)

| Data | Purpose | Basis | On erasure |
|---|---|---|---|
| Name, employee code, role, reporting line, dates of joining and leaving | Employment, audit attribution | LU (s.7(i)), Law | Kept: the audit trail and statutory registers say who did what |
| Work email | Sign-in, notices | LU (s.7(i)) | Replaced with `erased-<id>@erased.invalid` |
| Phone, address, city, state, PIN, gender | Employment administration | LU (s.7(i)) | Wiped |
| Avatar | Identification in the app | LU (s.7(i)) | File deleted |
| Uploaded HR documents (ID, offer letter, certificates) | Employment administration | LU (s.7(i)) | Rows and files deleted |
| Leave requests: dates, days, reason, decision note | Leave administration | LU (s.7(i)) | Reason and note wiped, dates kept |
| Attendance: date, status, in/out time, note | Attendance | LU (s.7(i)), Law | Note wiped, attendance kept |
| Sign-in sessions: IP, browser | Security | LU (s.7(i)), Rule 6 | Revoked and deleted |

## Parties (`parties`, `party_addresses`, `labour_wage_profiles`, `attendance_records`, `advances`)

One table holds customers, vendors, contractors, labour and sales references. Many are businesses, which the Act does not cover. The ones that are individuals are Data Principals.

| Data | Purpose | Basis | On erasure |
|---|---|---|---|
| Name, GSTIN, state | Invoices, GST, wage register | LU (s.7(a)), Law | Kept |
| Phone, email, address, billing address, city, PIN | Orders, delivery, contact | LU (s.7(a)) | Wiped |
| Aadhaar, PAN, date of birth, gender, ESIC/UAN, badge number | Labour identity, statutory returns, TDS | LU (s.7(i)), Law | Wiped |
| Bank account, IFSC, bank, branch, beneficiary | Payments | LU (s.7(a)) | Wiped |
| Emergency contact name and phone | Labour safety | LU (s.7(i)) | Wiped |
| Address book: contact person, phone, address lines, PIN | Delivery | LU (s.7(a)) | Wiped. The row stays because challans point at it. |
| Wages, attendance, advances | Wage payment, wage register | Law | Kept |

Aadhaar, PAN, bank details, ESIC/UAN, date of birth and emergency contact are masked from anyone without `PARTY_SENSITIVE_READ`, and are never written into the audit trail.

## Enquiries (`leads`, `lead_activities`, `quotations` for prospects)

| Data | Purpose | Basis | On erasure |
|---|---|---|---|
| Contact name, phone, email, city, state, requirement, lost reason | Following up the enquiry | C (or LU s.7(a) for a single quotation) | Wiped. The name becomes "Erased enquiry LD/…". |
| Activity subjects and details | Follow-up history | C | Wiped |
| Prospect name and phone on quotations | Quoting | C | Wiped |
| Lead number, status, dates, estimated value | Sales records | Business record | Kept |

## Drivers (`vehicles`, `delivery_challans`, `sales_invoices`)

| Data | Purpose | Basis | On erasure |
|---|---|---|---|
| Driver name, phone, licence number (vehicles) | Dispatch | LU (s.7(a)) | Not automated. Edit the vehicle record. |
| Driver name, vehicle number (on challans and invoices) | E-way bill and delivery record | Law | Kept |

## Records the privacy module itself creates

| Table | Holds | Kept |
|---|---|---|
| `consent_records` | Who consented to what, how, and when | Permanently, as evidence. Contact details are wiped when the person is erased. |
| `data_principal_requests` | Requests and their outcomes, including the requester's contact | Permanently, as evidence of compliance |
| `privacy_nominees` | Nominee name and contact | Until replaced or the person is erased |
| `data_breaches` | Breach register | Permanently |
| `notice_acknowledgements` | Which user saw which notice version, from which IP | Permanently |

## System-wide copies

| Where | What | Handling |
|---|---|---|
| `audit_logs` | Before/after snapshots of every audited record, with user and IP | Masked for an erased person. Old snapshots are masked by the retention rule. Never purged within a year (Rule 6). |
| `master_import_runs.payload` | Rows of an uploaded Excel sheet | Cleared 7 days after an import |
| `idempotency_keys.responseBody` | Cached API responses | Deleted after 24 hours |
| `notifications` | Alert text, which can name a customer | Not erased automatically |
| Application logs | IP address, path, browser; personal fields are redacted | Held by the hosting platform under its own retention |
| Backups | Everything | Erasure reaches backups only when they expire. State the backup retention period in the notice. |

## Processors

| Processor | Data | Purpose |
|---|---|---|
| Brevo | Staff name, email, sign-in and reset links | Email delivery |
| Render | All data in transit and in memory | Running the API |
| Vercel | None stored; serves the web app | Web hosting |
| Database host | All stored data | Storage |
| India Post pincode API | The PIN code typed in a form (from the browser) | Address lookup |
| Google Fonts | The visitor's IP address (from the browser) | Fonts |

Record each processor's storage location in the notice. Locations outside India are allowed unless the Government restricts that country (s.16).
