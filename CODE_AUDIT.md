# Facility App — Senior Developer Code Audit

**Date:** June 10, 2026  
**Stack:** Angular 19 + Ionic 8 + Firebase Firestore (no Auth SDK)  
**Assessment:** Frank, unfiltered. Every issue found is documented.

---

## Priority #1: The Sign-In Button Does Nothing

**Root cause identified.** There are actually two separate problems here, not one.

**Problem A — The nav "Sign In" link doesn't open the keypad.**

In `app.component.html`, the unauthenticated state shows:
```html
<a *ngIf="!isAuthenticated" routerLink="/home" class="nav-btn nav-btn--signin">
  Sign In
</a>
```
This is just a plain router link. It navigates to `/home`. It does NOT call `openKeypad()`. It does nothing that triggers authentication.

**Problem B — The home page has no button to open the keypad.**

In `home.page.ts`, `openKeypad()` exists and works correctly. In `home.page.html`, the keypad modal exists with `[isOpen]="keypadOpen"`. But there is **no button anywhere on the home page template that calls `openKeypad()`**. The keypad modal is fully functional — it's just completely unreachable from the UI.

**Fix:** Either (a) change the nav "Sign In" link to a button with `(click)` that navigates to home AND opens the keypad, or (b) add an "Admin Login" / unlock button to the home page grid that calls `openKeypad()`. Option (b) is cleaner.

---

## BUGS

### 1. Wellness Check "No" Answer Locks the User Forward
**File:** `src/app/signin/signin.page.html`

The Next/Finish buttons use:
```html
[disabled]="!wellnessData[wellnessQuestions[currentQuestionIndex].property]"
```
When a student answers "No" to a yes/no question, the value stored is `false`. Because `!false === true`, the button stays disabled. Students who answer "No" to "Did you eat nutritious food today?" or "Did you drink enough water?" cannot proceed. This is a real, reproducible block.

**Fix:** Change the disabled condition to check for `undefined`/`null` explicitly:
```html
[disabled]="wellnessData[wellnessQuestions[currentQuestionIndex].property] === undefined || wellnessData[wellnessQuestions[currentQuestionIndex].property] === null"
```

---

### 2. Schedule Edit/Delete Doesn't Work on Any Session
**File:** `src/app/schedule/schedule.page.ts`

Sessions displayed on the schedule are **generated from packages** in `loadSessionsWindow()`. These generated `Session` objects have no `id` field — they're constructed in memory, never saved to Firestore. When a user tries to edit or delete one of these sessions, the code calls `firebaseService.updateSession(session.id!, ...)` or `firebaseService.deleteSession(session.id!)` where `session.id` is `undefined`. The operation either fails silently or throws.

The edit form can be opened (it populates correctly), but saving does nothing useful. The delete confirmation runs, but nothing gets deleted.

---

### 3. `workouts-list` Auto-Seeds Test Data to Production Firebase
**File:** `src/app/workouts-list/workouts-list.page.ts`, lines 74–79

```typescript
if (this.workouts.length === 0) {
  await this.createTestWorkouts();
}
```

Every time the Workouts page loads against an empty Firestore `workouts` collection, it automatically writes a "Full Body Strength" test workout to your live database. This is development scaffolding that was never removed. It will fire on any new Firebase project or after all workouts are deleted.

---

### 4. `analytics-outline` Icon Not Registered in Home Page
**File:** `src/app/home/home.page.ts` vs `home.page.html`

`home.page.html` includes a "Control Room" button using `analytics-outline`, but `home.page.ts`'s `addIcons()` call does not register `analyticsOutline`. The icon will silently render blank. (It IS registered in `app.component.ts`, so it may appear to work depending on load order, but this is fragile and technically incorrect.)

---

### 5. `sessions.page.ts` Uses Non-Standalone `IonicModule` 
**Files:** `src/app/sessions/sessions.page.ts`, `src/app/workouts-list/workouts-list.page.ts`

Both pages import `IonicModule` from `@ionic/angular` (the full barrel module) instead of individual components from `@ionic/angular/standalone`. Every other page in this app uses the standalone pattern correctly. These two pages import the **entire Ionic library**, defeating tree-shaking and bloating the bundle by roughly 200–400KB.

---

### 6. Sessions Page is an Unreachable Orphan
**File:** `src/app/sessions/sessions.page.ts`

The `/sessions` route is registered in `app.routes.ts`, and the page has substantial logic (grouping sessions by today/future/past, linking workouts). But there is no navigation link to `/sessions` anywhere in `app.component.html` or `home.page.html`. Users cannot reach it. The `linkWorkout()` and `unlinkWorkout()` workflows navigate TO `/sessions` as a destination, but users have no way to get there organically.

---

### 7. `navigateBack()` Reads `workoutTimerState` from localStorage, but It's Never Written
**File:** `src/app/workouts/workouts.page.ts`, line 216

```typescript
const savedState = localStorage.getItem('workoutTimerState');
```

Nothing in the entire codebase ever calls `localStorage.setItem('workoutTimerState', ...)`. This branch is dead. It suggests a workout timer feature was partially planned and scaffolded but never built.

---

### 8. `getStudentWaivers()` Fetches the Entire Waivers Collection
**File:** `src/app/services/firebase.service.ts`, line 487

```typescript
const querySnapshot = await getDocs(collection(this.db, 'waivers'));
querySnapshot.forEach((doc) => {
  if (data['studentName'].toLowerCase() === studentName.toLowerCase()) { ... }
```

This fetches ALL waivers from Firestore then filters in JavaScript. With 100 clients who each signed two waivers, that's 200 document reads for every student profile page load. Should be a `where` query.

---

### 9. `setDoc` Uses Student Name as Firestore Document ID
**File:** `src/app/services/firebase.service.ts`, line 854

```typescript
const overrideRef = doc(this.db, 'studentStatsOverrides', studentName);
```

Firestore document IDs cannot contain forward slashes. Any student whose name contains `/` (unlikely but possible) will crash the write. More importantly, names with spaces, accents, or other special characters can create problems with indexing. Use the Firestore-generated document ID, not a human name.

---

### 10. `students.page.ts` Generates Client IDs That Reset Every Page Load
**File:** `src/app/students/students.page.ts`, lines 284–287

```typescript
clientId: s.clientId || `CL-${(idx + 1).toString().padStart(4, '0')}`
```

For students who don't have a `clientProfile` document in Firestore yet, this assigns `CL-0001`, `CL-0002`, etc. based on their **current sorted array position**. These IDs are regenerated fresh every time the page loads. Add a student, and the IDs shift. The IDs displayed in the table are meaningless until the student has a saved profile.

---

## SECURITY ISSUES

### S1. PIN Hardcoded in Source Code
**File:** `src/app/home/home.page.ts`, line 29

```typescript
private correctCode = '7210';
```

The admin PIN is visible in plaintext in the source file. Anyone with repository access (or who can read a production JS bundle) has the PIN. Move this to environment config, or better yet, use Firebase Authentication.

---

### S2. Authentication Bypassable via Browser Console
**File:** `src/app/services/auth.service.ts`

Authentication state is stored in `localStorage` as the string `"true"`. Any user who opens their browser's developer console and runs:
```javascript
localStorage.setItem('facility_auth_state', 'true'); location.reload();
```
is instantly authenticated as admin with full access to all client data, schedules, and payment records. No token, no expiry, no server validation.

---

### S3. No Route Guards — All Admin Routes Are Publicly Accessible by Direct URL
**File:** `src/app/app.routes.ts`

There are no Angular `CanActivate` guards on any route. The `*ngIf="isAuthenticated"` on nav links only hides links — it does NOT prevent navigation. Anyone can type `https://yourapp.com/students` directly into the address bar and access the full client database without a PIN. This is a complete auth bypass. Route guards are mandatory for any data that should require login.

---

### S4. Firebase API Key and Config Committed to Source
**File:** `src/environments/environment.ts`

The Firebase API key, project ID, app ID, and measurement ID are all committed to the repository. While Firebase API keys are technically designed to be public (security is enforced by Firestore rules), this matters because your Firestore security rules almost certainly allow unauthenticated reads/writes (since the app uses no Firebase Auth). Any person who finds your project ID can read or write your entire Firestore database — client names, phone numbers, emails, waivers, signatures, payment records — with no authentication required.

**Audit your Firestore security rules immediately.** They should not allow unauthenticated access.

---

### S5. Signature Images Stored as Base64 in Firestore Documents
**File:** `src/app/waiver/waiver.page.ts`, `src/app/services/firebase.service.ts`

Waiver signature drawings are stored as `signatureDataUrl` (base64-encoded PNG) directly inside Firestore documents. Firestore has a **1MB per-document hard limit**. A signature drawing encoded as base64 can easily be 50–200KB. Once you have a handful of waivers per client, individual documents may approach or hit this limit, causing silent write failures. Use Firebase Storage for binary data and store only a download URL in Firestore.

---

### S6. Payment Calculation Uses Hardcoded $25/Session Rate
**File:** `src/app/students/students.page.ts`, line 783

```typescript
const totalOwed = attendedSessions * 25;
```

The "Remaining Balance" display on student profiles calculates what's owed using a hardcoded $25/session group rate regardless of the student's actual package type. A private training client at $55/session will show wildly incorrect balance figures. This is financial logic that needs to be connected to the actual package records.

---

## CODE QUALITY ISSUES

### Q1. Massive Debug Logging Left in Production Code

`firebase.service.ts` contains emoji-decorated debug logs in `saveWorkout()`:
```typescript
console.log('🔥 Firebase saveWorkout() called');
console.log('📊 Input workout data:', JSON.stringify(workout, null, 2));
console.log('🌐 Firebase database instance:', this.db ? 'Available' : 'Not available');
```

`sessions.page.ts` logs every session categorization step. `workouts-list.page.ts` logs the full workout payload on every load. These need to be stripped before considering this production-ready.

---

### Q2. Dead Methods That Should Be Deleted

**`schedule.page.ts`:**
- `toggleDay()` — body is a comment: `// This method is no longer needed`. Delete it.
- `testButton()` — calls `alert('Button click works!')`. This is test code committed to the repo.
- `onSessionClick()` — body is a comment: `// Intentionally no-op for now`. Either implement it or remove it.
- `loadSessions()` — fully functional but replaced by `loadSessionsWindow()`. Still called from `performDeletePastSession()`, creating an inconsistency (deleting a session then reloads via full getSessions, not package-generated view).

**`students.page.ts`:**
- `calculateTotal()` — empty method body with a comment saying the work is done in the template.

---

### Q3. Students Page N+1 Query Problem
**File:** `src/app/students/students.page.ts`, lines 241–278

For each student in the list, `loadStudents()` makes three separate async calls in sequence:
1. `getStudentStats()` → internally calls `getSessions()` AND `getStudentAttendance()` AND `getStudentStatsOverride()`
2. `getStudentPayments()`
3. `getTotalPayments()` (which calls `getStudentPayments()` again — duplicate call)

With 10 students, that's ~40 Firestore queries, many of them fetching the entire sessions collection repeatedly. Loading the students page with 20+ clients will be noticeably slow. The sessions collection should be fetched once and passed through.

---

### Q4. Two Parallel Session Data Sources That Are Out of Sync

The app has a fundamental data model conflict:

- **Schedule page** generates sessions dynamically from package records (packages → compute occurrence dates → virtual Session objects with no Firestore ID)
- **Sessions page, Sign-in page, Students page** use directly-stored Firestore sessions from the `sessions` collection

These two sources are independent. Sessions visible on the Schedule will not appear when checking students in (unless they were also manually added to the `sessions` collection). Attendance recorded via the sign-in page cannot match back to a schedule-generated session because those sessions have no ID.

This is an architectural decision that needs to be made deliberately: pick one source of truth and migrate everything to it.

---

### Q5. `ChangeDetectionStrategy.OnPush` Mixed with Mutable State
**File:** `src/app/schedule/schedule.page.ts`

The schedule component uses `OnPush` change detection, which requires immutable state changes to trigger re-rendering. But throughout the component, arrays are mutated directly: `participants.splice(...)`, `participants.push(...)`, `selectedDates` is modified in place. With `OnPush`, Angular may not detect these mutations, causing stale UI that doesn't reflect the current data. The `cdr.markForCheck()` calls scattered through the code are a sign this is already causing issues.

---

### Q6. `String(this.paymentForm.sessionType) !== ''` Pattern
**File:** `src/app/students/students.page.ts`, lines 811–815

```typescript
sessionType: String(this.paymentForm.sessionType) !== '' ? this.paymentForm.sessionType : 'group'
```

This check is redundant — `paymentStatus` is already typed and `isPaymentFormValid()` validates it before `savePayment()` is called. The double-cast `String(x) !== ''` pattern suggests a previous bug with undefined values that was patched without addressing the root cause.

---

### Q7. `as any` Type Coercion Used to Bypass TypeScript Checks

The codebase has dozens of `as any` casts, particularly in Firebase service methods. Examples: `addDoc(collection(this.db, 'clientProfiles'), { ... } as any)`, `updateDoc(ref, { ...partial } as any)`. These defeat the purpose of TypeScript. If the type doesn't match, fix the interface — don't cast away the error.

---

## UX / DESIGN ISSUES

### U1. Dashboard ("Control Room") Shows Entirely Fake Data
**File:** `src/app/dashboard/dashboard.page.ts`

The Control Room dashboard displays animated terminal output about quantum computing qubits, satellite uplinks, neural network training, HVAC environmental control, and surveillance cameras. None of this is real gym data. It makes zero calls to Firebase. The "Control Room" concept is compelling aesthetically, but the page currently shows fabricated sci-fi server data while the actual gym metrics (today's attendance, upcoming sessions, revenue, package utilization) go untracked anywhere in the app.

This page needs to be rebuilt to show real business data before it serves any purpose.

---

### U2. No Route Guard Means Unauthenticated Users See Client Data if They Know URLs

Already listed as a security issue (S3), but also a UX issue. If an unauthenticated person stumbles onto `/students`, they see the full client list with names, phones, emails, payment history, and waiver signatures. There's no "you need to be logged in" redirect — they just see everything.

---

### U3. "Sign In" Nav Button Routes to Home, Not to the Keypad

The unauthenticated nav bar shows "Sign In" with a keypad icon, which creates the expectation that clicking it will show a PIN entry. Instead it navigates to `/home` — the same page you're already on — and nothing visible happens. This is confusing and is the reported "sign-in button does nothing" complaint.

---

### U4. Waiver Page Uses Native `alert()` Instead of Ionic AlertController
**File:** `src/app/waiver/waiver.page.ts`, line 87

```typescript
alert('You must agree to the terms first.');
```

This shows a raw browser alert dialog, which looks completely out of place in a styled Ionic app and doesn't work consistently across Capacitor (native iOS/Android) deployments.

---

### U5. Feedback Page Doesn't Autofill Student Name
**File:** `src/app/feedback/feedback.page.ts`

The feedback form has a free-text name field. Students must type their name exactly as it's stored. If they type "John" instead of "John Smith", the feedback won't be linkable to their profile. At minimum, this should offer a dropdown or autocomplete from the student list.

---

### U6. Student Page Loads the Full Session List for Every Student's Stat Calculation

Covered in Q3, but from a UX perspective: opening the Students page triggers a loading spinner for 3–8 seconds even with a small database. The sequential query pattern creates a visibly slow experience. Users will assume the app is broken.

---

### U7. Package-Generated Sessions Can't Be Checked Into via Sign-In Page

The check-in flow (`/signin`) loads today's sessions via `firebaseService.getSessions()`, which reads from the `sessions` Firestore collection. Package-generated sessions exist only in memory on the schedule page. If your schedule shows sessions derived from packages, those sessions won't appear on the check-in screen. Students can't be checked in.

This is the operational impact of the dual data source architecture (Q4 above). It means the check-in screen may show "No sessions today" even when the schedule clearly shows a session.

---

## MISSING FEATURES (SCAFFOLDED BUT NOT IMPLEMENTED)

1. **Workout timer** — `workoutTimerState` localStorage key referenced in multiple places, the whole `saveDraft()` / `navigateBack()` logic in workouts.page references it, but no timer UI exists anywhere.

2. **Session-workout display** — `session-workout-view` route and page exist. The sessions page navigates to it. Not audited in depth but appears to display a workout for a session — this is likely functional but has the same sessions page orphan problem (no organic navigation to it for the end user).

3. **Real dashboard metrics** — Control Room is entirely decorative. No real attendance, revenue, or capacity data is surfaced anywhere in the app.

4. **Client onboard date** — `onboardDate` field exists in `ClientProfile` and shows in the table, but there's no input to set it. It defaults to the ISO date of when the row was created in the app (not when the client actually onboarded).

5. **Waiver lookup from student profile** — Student profiles show a "Waivers" section, but there's no way to re-download or view signed waivers. The signature image is stored in Firestore but displayed only as a small thumbnail.

6. **Package sessions-remaining counter** — `sessionsRemaining` is calculated on the packages page, but it's not surfaced in a meaningful way (no alert when a client has 1 session left, no integration with check-in to decrement it).

7. **No feedback admin view** — Feedback is collected and stored in Firestore but there's no admin UI to read it. The data goes into a black hole.

---

## PERFORMANCE CONCERNS

1. **No pagination or virtualization** on the students table. With 50+ clients, the table renders all rows at once. The column-resize drag listener attaches to `window` (not the component element), which accumulates if the component is destroyed and recreated.

2. **`loadSessionsWindow()` iterates day-by-day** over potentially years of package schedule data. For a 6-month package that started 3 months ago, it iterates every single day from the start of the package counting occurrences before the window. This is O(days) per package, per page navigation. For 20 active packages, this runs 20 × 180 = 3,600 loop iterations on every weekly navigation. It's fast today, but it's not the right algorithm.

3. **`ionViewWillEnter` triggers full data reload on every page visit.** Schedule, sessions, and students pages all reload their entire dataset every time you navigate back to them. There's no caching layer.

4. **`ngAfterViewChecked` → `scrollToBottom()` on dashboard.** `ngAfterViewChecked` fires on every change detection cycle. The dashboard triggers change detection every 1–3 seconds via multiple `setInterval` calls. Every cycle calls `scrollToBottom()` which reads `scrollHeight` — a DOM measurement that forces layout reflow. This adds measurable frame jank to the dashboard animations.

---

## SUMMARY TABLE

| Category | Count | Severity |
|----------|-------|----------|
| Hard bugs (broken functionality) | 6 | Critical/High |
| Security vulnerabilities | 6 | Critical/High |
| Code quality issues | 7 | Medium |
| UX/design problems | 7 | Medium/Low |
| Missing/incomplete features | 7 | Low |
| Performance issues | 4 | Medium |

---

## Recommended Fix Order

**Do these first (app is unusable or insecure without them):**
1. Add a button to home page that triggers `openKeypad()` — the auth entrypoint is broken
2. Add Angular route guards to all admin routes (`/students`, `/schedule`, `/workouts`, `/packages`)
3. Audit and lock down Firestore security rules to prevent unauthenticated reads/writes
4. Fix the wellness check "No" answer disabling the next button
5. Remove the `createTestWorkouts()` auto-seeder from `workouts-list`

**Do these soon (operational issues):**
6. Fix session data source conflict — pick packages or Firestore sessions, not both
7. Fix check-in page to find today's sessions from whichever data source is chosen
8. Strip all debug `console.log()` statements
9. Move signatures to Firebase Storage
10. Fix `getStudentWaivers()` to use a Firestore `where` query

**Do these before calling it production-ready:**
11. Replace hardcoded PIN with Firebase Authentication
12. Replace localStorage auth state with proper auth tokens
13. Build a real dashboard with actual gym metrics
14. Fix `getRemainingBalance()` to use real package rates
15. Add route for the sessions page to the navigation
