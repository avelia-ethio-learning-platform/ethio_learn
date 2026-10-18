# Amharic strings for review (Phase 10)

Phase 10 translated a new learner's path into Amharic. The implementer drafted every string below;
a native speaker should check each one before we rely on it. A correction is an edit to the value
in `web/src/lib/i18n-am.ts` (same key). Placeholders in braces, like `{n}` or `{amount}`, are filled
in by the app and must stay as they are; the parity test (`web/src/lib/i18n.test.ts`) fails if one goes missing.

Strings that existed before Phase 10 (the header, footer, home page and parts of the catalog) are not listed.

225 strings.

## Shell

| Key | English | Amharic draft |
|---|---|---|
| `retry` | Retry | እንደገና ሞክር |
| `checking` | Checking… | በማረጋገጥ ላይ… |
| `error_title` | Something went wrong | የሆነ ችግር ተፈጥሯል |
| `error_body` | Please try again. If it keeps happening, come back a little later. | እባክዎ እንደገና ይሞክሩ። ችግሩ ከቀጠለ ትንሽ ቆይተው ይመለሱ። |
| `not_found_title` | We couldn't find that page | ያንን ገጽ ማግኘት አልቻልንም |
| `not_found_body` | It may have moved, or the link may be wrong. Try searching for a course instead. | ገጹ ተዛውሮ ሊሆን ይችላል፣ ወይም ሊንኩ የተሳሳተ ሊሆን ይችላል። በምትኩ ኮርስ ይፈልጉ። |
| `search_courses` | Search courses | ኮርሶችን ፈልግ |
| `waking_title` | We're waking up the server | ሰርቨሩን እያስነሳን ነው |
| `waking_body` | This can take up to a minute after a quiet period. Try again in a moment. | ለተወሰነ ጊዜ ጥቅም ላይ ካልዋለ በኋላ እስከ አንድ ደቂቃ ሊወስድ ይችላል። ትንሽ ቆይተው እንደገና ይሞክሩ። |
| `waking_notice` | Waking up the server. This can take up to a minute on the first visit. | ሰርቨሩን በማስነሳት ላይ። በመጀመሪያው ጉብኝት እስከ አንድ ደቂቃ ሊወስድ ይችላል። |
| `read_more` | Read more | ተጨማሪ ያንብቡ |
| `show_less` | Show less | ያነሰ አሳይ |
| `theme` | Theme | ገጽታ |

## Course page

| Key | English | Amharic draft |
|---|---|---|
| `n_sections` | {n} sections | {n} ክፍሎች |
| `n_lessons` | {n} lessons | {n} ትምህርቶች |
| `about_n_min` | ~{n} min | ~{n} ደቂቃ |
| `n_min` | {n} min | {n} ደቂቃ |
| `lang_en` | English | እንግሊዝኛ |
| `lang_am` | Amharic | አማርኛ |
| `certificate` | Certificate | ሰርተፊኬት |
| `recently_updated` | Recently updated | በቅርቡ የተሻሻለ |
| `course_by` | By | አስተማሪ፦ |
| `buy_bullet_certificate` | Verifiable certificate on completion | ሲያጠናቅቁ የሚረጋገጥ ሰርተፊኬት |
| `buy_bullet_payment` | Pay with Telebirr, CBE Birr & 18+ banks | በቴሌብር፣ በሲቢኢ ብር እና ከ18 በላይ ባንኮች ይክፈሉ |
| `buy_bullet_refund` | 7-day refund window | የ7 ቀን ተመላሽ ገንዘብ ጊዜ |

## Login, signup, reset password, verify email

| Key | English | Amharic draft |
|---|---|---|
| `login_subtitle` | Welcome back — pick up right where you left off. | እንኳን ደህና መጡ — ካቆሙበት ይቀጥሉ። |
| `logging_in` | Logging in… | በመግባት ላይ… |
| `resend_verification_email` | Resend verification email | የማረጋገጫ ኢሜይሉን እንደገና ላክ |
| `password_rule` | Password must include at least 3 of: lowercase, uppercase, number, symbol (min 8 chars). | የይለፍ ቃሉ ቢያንስ 8 ቁምፊዎች ሊኖሩት እና ከእነዚህ ቢያንስ 3ቱን ማካተት አለበት፦ ትንሽ ፊደል፣ ትልቅ ፊደል፣ ቁጥር፣ ምልክት። |
| `check_email_title` | Check your email | ኢሜይልዎን ይመልከቱ |
| `check_email_subtitle` | One more step to activate your account. | መለያዎን ለማንቃት አንድ እርምጃ ብቻ ቀርቷል። |
| `check_email_body` | We sent a verification link to your inbox. Click it, then | ወደ ኢሜይልዎ የማረጋገጫ ሊንክ ልከናል። ሊንኩን ይጫኑ፣ ከዚያ |
| `signup_subtitle` | Join Ethiopia's educator-first learning community. | የኢትዮጵያን አስተማሪ-ተኮር የትምህርት ማህበረሰብ ይቀላቀሉ። |
| `have_account` | Already have an account? | መለያ አለዎት? |
| `password_min` | Password (8+ characters) | የይለፍ ቃል (ቢያንስ 8 ቁምፊዎች) |
| `joining_as` | I am joining as | የምቀላቀለው እንደ |
| `role_learner_option` | Learner — I want to take courses | ተማሪ — ኮርሶችን መውሰድ እፈልጋለሁ |
| `role_educator_option` | Educator — I want to teach | አስተማሪ — ማስተማር እፈልጋለሁ |
| `role_institution_option` | Institution — training center / bootcamp | ተቋም — የስልጠና ማዕከል ወይም ቡትካምፕ |
| `no_phone` | No phone number required — just email and password. | ስልክ ቁጥር አያስፈልግም — ኢሜይል እና የይለፍ ቃል ብቻ። |
| `creating` | Creating… | በመፍጠር ላይ… |
| `resend_email` | Resend email | ኢሜይሉን እንደገና ላክ |
| `resend_in` | Resend in {s} s | በ{s} ሰከንድ እንደገና መላክ ይቻላል |
| `enter_valid_email` | Enter a valid email address. | ትክክለኛ የኢሜይል አድራሻ ያስገቡ። |
| `too_many_requests` | Too many requests. Wait a minute and try again. | በጣም ብዙ ጥያቄዎች። አንድ ደቂቃ ጠብቀው እንደገና ይሞክሩ። |
| `send_failed` | Couldn't send right now. Try again in a minute. | አሁን መላክ አልተቻለም። ከአንድ ደቂቃ በኋላ እንደገና ይሞክሩ። |
| `strength` | Strength: | ጥንካሬ፦ |
| `strength_very_weak` | Very weak | በጣም ደካማ |
| `strength_weak` | Weak | ደካማ |
| `strength_good` | Good | ጥሩ |
| `strength_strong` | Strong | ጠንካራ |
| `pw_at_least_8` | At least 8 characters | ቢያንስ 8 ቁምፊዎች |
| `pw_three_of_four` | 3 of these 4: | ከእነዚህ 4 ውስጥ 3ቱ፦ |
| `pw_lowercase` | lowercase | ትንሽ ፊደል |
| `pw_uppercase` | uppercase | ትልቅ ፊደል |
| `pw_number` | number | ቁጥር |
| `pw_symbol` | symbol | ምልክት |
| `pw_met` | Met: | ተሟልቷል፦ |
| `pw_not_met` | Not met: | አልተሟላም፦ |
| `set_new_password` | Set a new password | አዲስ የይለፍ ቃል ያዘጋጁ |
| `reset_your_password` | Reset your password | የይለፍ ቃልዎን ዳግም ያስጀምሩ |
| `choose_strong_password` | Choose a strong password for your account. | ለመለያዎ ጠንካራ የይለፍ ቃል ይምረጡ። |
| `reset_link_info` | We'll email you a signed, time-limited reset link. | ጊዜው የተገደበ የይለፍ ቃል ማስጀመሪያ ሊንክ በኢሜይል እንልክልዎታለን። |
| `new_password_min` | New password (8+ characters) | አዲስ የይለፍ ቃል (ቢያንስ 8 ቁምፊዎች) |
| `account_email` | Account email | የመለያ ኢሜይል |
| `working` | Working… | በሂደት ላይ… |
| `update_password` | Update password | የይለፍ ቃል አዘምን |
| `send_reset_link` | Send reset link | የማስጀመሪያ ሊንክ ላክ |
| `missing_token` | Missing verification token. | የማረጋገጫ ሊንኩ ሙሉ አይደለም። |
| `verifying` | Verifying… | በማረጋገጥ ላይ… |
| `email_verified` | Email verified | ኢሜይል ተረጋግጧል |
| `verification_failed` | Verification failed | ማረጋገጥ አልተሳካም |
| `go_to_login` | Go to login | ወደ መግቢያ ሂድ |

## Course page: buy box, gift and ask-to-pay

| Key | English | Amharic draft |
|---|---|---|
| `learner_only_enroll` | Log in as a learner to enroll. | ለመመዝገብ እንደ ተማሪ ይግቡ። |
| `mode_buy` | Buy for me | ለራሴ ግዛ |
| `mode_gift` | Gift it | በስጦታ ስጥ |
| `mode_ask` | Ask someone to pay | ሌላ ሰው እንዲከፍል ጠይቅ |
| `coupon_code` | Coupon code | የኩፖን ኮድ |
| `apply` | Apply | ተግብር |
| `coupon_pay_instead` | you pay {due} instead of {list} | ከ{list} ይልቅ {due} ይከፍላሉ |
| `please_wait` | Please wait… | እባክዎ ይጠብቁ… |
| `enroll_free_coupon` | Enroll free with coupon | በኩፖን በነጻ ይመዝገቡ |
| `pay_from_wallet_available` | Pay {amount} from my wallet ({balance} available) | ከዋሌቴ {amount} ክፈል ({balance} አለ) |
| `wallet_top_up_hint` | Wallet balance {balance} — top up from your dashboard to pay with credits. | የዋሌት ቀሪ ሂሳብ {balance} — በክሬዲት ለመክፈል ከዳሽቦርድዎ ይሙሉ። |
| `freemium_hint` | The first section is free to preview — buy to unlock everything. | የመጀመሪያው ክፍል በነጻ ለቅድመ እይታ ክፍት ነው — ሁሉንም ለመክፈት ይግዙ። |
| `gift_to_someone` | Gift this course to someone | ይህን ኮርስ ለሌላ ሰው በስጦታ ይስጡ |
| `gift_this_course` | Gift this course | ይህን ኮርስ በስጦታ ይስጡ |
| `recipient_email` | Recipient's email | የተቀባዩ ኢሜይል |
| `message_optional` | Message (optional) | መልዕክት (አማራጭ) |
| `gift_message_placeholder` | A short message (optional) | አጭር መልዕክት (አማራጭ) |
| `gift_invite_info` | If they don't have an account yet, we email them an invite and the course unlocks when they sign up with that address. You can follow their progress from your dashboard. | እስካሁን መለያ ከሌላቸው የግብዣ ኢሜይል እንልክላቸዋለን፤ በዚያው አድራሻ ሲመዘገቡ ኮርሱ ይከፈትላቸዋል። እድገታቸውን ከዳሽቦርድዎ መከታተል ይችላሉ። |
| `pay_with_chapa_amount` | Pay {amount} with Chapa | {amount} በቻፓ ይክፈሉ |
| `pay_from_wallet_balance` | Pay from my wallet ({balance}) | ከዋሌቴ ክፈል ({balance}) |
| `request_sent` | Request sent. We emailed {email}. | ጥያቄው ተልኳል። ለ{email} ኢሜይል ልከናል። |
| `ask_access_info` | You'll get access the moment they pay. You can also share this link directly: | እንደከፈሉ ወዲያውኑ መዳረሻ ያገኛሉ። ይህንን ሊንክም በቀጥታ ማጋራት ይችላሉ፦ |
| `payment_link` | Payment link | የክፍያ ሊንክ |
| `ask_title` | Ask someone to pay for you | ሌላ ሰው እንዲከፍልልዎ ይጠይቁ |
| `their_email` | Their email | የእነርሱ ኢሜይል |
| `their_email_placeholder` | Their email (parent, employer, friend…) | የእነርሱ ኢሜይል (ወላጅ፣ አሰሪ፣ ጓደኛ…) |
| `ask_message_placeholder` | Why this course matters to you (optional) | ይህ ኮርስ ለምን እንደሚያስፈልግዎ (አማራጭ) |
| `send_payment_request` | Send payment request | የክፍያ ጥያቄ ላክ |

## Course page preview; payment return

| Key | English | Amharic draft |
|---|---|---|
| `preview_intro` | Watch these lessons for free before you enroll. | ከመመዝገብዎ በፊት እነዚህን ትምህርቶች በነጻ ይመልከቱ። |
| `now_playing` | Now playing: {title} | አሁን እየተጫወተ ያለው፦ {title} |
| `pay_confirming` | Confirming your payment… | ክፍያዎን በማረጋገጥ ላይ… |
| `pay_youre_in` | You're in! | ተመዝግበዋል! |
| `pay_not_completed` | Payment not completed | ክፍያው አልተጠናቀቀም |
| `pay_still_processing` | Still processing | አሁንም በሂደት ላይ |
| `pay_checking_chapa` | We're checking with Chapa. If you just finished on the Chapa page, this takes a few seconds. | ከቻፓ ጋር እያረጋገጥን ነው። አሁን በቻፓ ገጽ ላይ ክፍያ ከጨረሱ ጥቂት ሰከንዶች ይወስዳል። |
| `pay_done_wallet` | Your wallet has been topped up. | ዋሌትዎ ተሞልቷል። |
| `pay_done_gift` | Payment confirmed — the learner now has access. | ክፍያው ተረጋግጧል — ተማሪው አሁን መዳረሻ አለው። |
| `pay_done_bulk` | Payment confirmed — assign your seats from the Institution page. | ክፍያው ተረጋግጧል — ቦታዎቹን ከተቋም ገጹ ይመድቡ። |
| `pay_done_course` | Payment confirmed and your course is unlocked. | ክፍያው ተረጋግጧል፣ ኮርስዎም ተከፍቷል። |
| `start_learning` | Start learning | መማር ጀምር |
| `continue` | Continue | ቀጥል |
| `pay_failed_info` | Chapa reported this checkout was cancelled or didn't go through — no money was taken. You can try again. | ቻፓ ይህ ክፍያ እንደተሰረዘ ወይም እንዳልተሳካ አሳውቋል — ምንም ገንዘብ አልተቆረጠም። እንደገና መሞከር ይችላሉ። |
| `back_to_course` | Back to the course | ወደ ኮርሱ ተመለስ |
| `pay_timeout_info` | We haven't seen a confirmation yet. If you completed the payment on Chapa, click below to check again. | እስካሁን ማረጋገጫ አላየንም። ክፍያውን በቻፓ ካጠናቀቁ እንደገና ለማረጋገጥ ከታች ይጫኑ። |
| `check_again` | Check again | እንደገና አረጋግጥ |
| `go_to_dashboard` | Go to dashboard | ወደ ዳሽቦርድ ሂድ |

## Status badges (every page)

| Key | English | Amharic draft |
|---|---|---|
| `status_draft` | Draft | ረቂቅ |
| `status_institution_review` | Institution review | የተቋም ግምገማ |
| `status_submitted` | Submitted | ገብቷል |
| `status_under_review` | Under review | በግምገማ ላይ |
| `status_published` | Published | ታትሟል |
| `status_flagged` | Flagged | ምልክት ተደርጎበታል |
| `status_unlisted` | Unlisted | ያልተዘረዘረ |
| `status_archived` | Archived | በማህደር የተቀመጠ |
| `status_active` | Active | ንቁ |
| `status_invited` | Invited | ተጋብዟል |
| `status_suspended` | Suspended | ታግዷል |
| `status_banned` | Banned | ተከልክሏል |
| `status_confirmed` | Confirmed | ተረጋግጧል |
| `status_pending` | Pending | በመጠባበቅ ላይ |
| `status_initiated` | Initiated | ተጀምሯል |
| `status_failed` | Failed | አልተሳካም |
| `status_refunded` | Refunded | ተመላሽ ተደርጓል |
| `status_paid` | Paid | ተከፍሏል |
| `status_held` | Held | ተይዟል |
| `status_approved` | Approved | ጸድቋል |
| `status_denied` | Denied | ውድቅ ተደርጓል |

## Dashboard

| Key | English | Amharic draft |
|---|---|---|
| `dashboard_subtitle` | Your courses, certificates, wallet and payments in one place. | ኮርሶችዎ፣ ሰርተፊኬቶችዎ፣ ዋሌትዎ እና ክፍያዎችዎ በአንድ ቦታ። |
| `no_enrollments` | You haven't enrolled in any course yet. | እስካሁን በየትኛውም ኮርስ አልተመዘገቡም። |
| `browse_the_catalog` | Browse the catalog | ካታሎጉን ያስሱ |
| `course_fallback` | Course | ኮርስ |
| `finished` | finished | ተጠናቋል |
| `gifted` | gifted | በስጦታ የተገኘ |
| `revisit` | Revisit | እንደገና ይመልከቱ |
| `certificates_empty` | Complete a course (and its assessments) to earn a verifiable certificate. | የሚረጋገጥ ሰርተፊኬት ለማግኘት ኮርስን (እና ፈተናዎቹን) ያጠናቅቁ። |
| `issued_on` | Issued {date} | የተሰጠበት ቀን፦ {date} |
| `public_verification` | Public verification | ይፋዊ ማረጋገጫ |
| `download_pdf` | Download PDF | PDF አውርድ |
| `no_payments` | No payments yet. | እስካሁን ምንም ክፍያ የለም። |
| `no_refunds` | No refund requests. | የተመላሽ ገንዘብ ጥያቄ የለም። |
| `purpose_wallet_topup` | wallet topup | ዋሌት መሙላት |
| `purpose_gift` | gift | ስጦታ |
| `purpose_pay_request` | pay request | የክፍያ ጥያቄ |
| `purpose_bulk` | bulk | በጅምላ |
| `invite_none_sent` | No new invitations sent: these people already have an account or were invited recently. | አዲስ ግብዣ አልተላከም፦ እነዚህ ሰዎች መለያ አላቸው ወይም በቅርቡ ተጋብዘዋል። |
| `invites_sent_one` | Sent 1 invitation. | 1 ግብዣ ተልኳል። |
| `invites_sent` | Sent {n} invitations. | {n} ግብዣዎች ተልከዋል። |
| `invite_earn` | Invite & earn | ይጋብዙ እና ያግኙ |
| `invite_reward` | Get {amount} in your wallet when someone you invite makes their first purchase. | የጋበዙት ሰው የመጀመሪያ ግዢውን ሲፈጽም {amount} ወደ ዋሌትዎ ይገባል። |
| `your_invite_link` | Your invite link | የእርስዎ የግብዣ ሊንክ |
| `copied` | Copied | ተቀድቷል |
| `copy` | Copy | ቅዳ |
| `friends_emails` | Friends' email addresses | የጓደኞች ኢሜይል አድራሻዎች |
| `personal_note` | Personal note (optional) | የግል ማስታወሻ (አማራጭ) |
| `invite` | Invite | ጋብዝ |
| `referral_stats` | {joined} joined · {purchased} purchased · earned {earned} | {joined} ተቀላቅለዋል · {purchased} ገዝተዋል · {earned} አግኝተዋል |
| `gifts_title` | Gifts & sponsored learning | ስጦታዎች እና የተደገፈ ትምህርት |
| `gifts_given` | Courses you paid for others | ለሌሎች የከፈሉባቸው ኮርሶች |
| `n_complete` | {n}% complete | {n}% ተጠናቋል |
| `waiting_signup` | Waiting for them to sign up with that email. | በዚያ ኢሜይል እስኪመዘገቡ በመጠበቅ ላይ። |
| `gifted_to_you` | Gifted to you | ለእርስዎ በስጦታ የተሰጡ |
| `gift_from` | from {name} | ከ{name} |
| `a_sponsor` | a sponsor | አንድ ደጋፊ |
| `open` | Open | ክፈት |
| `pay_requests_sent` | Payment requests you sent | የላኳቸው የክፍያ ጥያቄዎች |
| `asked_email` | asked {email} | የተጠየቀው፦ {email} |
| `copy_link` | Copy link | ሊንኩን ቅዳ |
| `refund_confirm_title` | Request a refund for {course}? | ለ{course} ተመላሽ ገንዘብ ይጠይቃሉ? |
| `refund_confirm_body` | You paid {amount}. The refund rules decide whether it is approved, reviewed by our team, or declined. | {amount} ከፍለዋል። ጥያቄው እንደሚጸድቅ፣ በቡድናችን እንደሚታይ ወይም ውድቅ እንደሚሆን የተመላሽ ገንዘብ ደንቦቹ ይወስናሉ። |
| `request_refund` | Request refund | ተመላሽ ገንዘብ ጠይቅ |
| `refund_why` | Why do you want a refund? | ተመላሽ ገንዘብ ለምን ይፈልጋሉ? |
| `refund_outcome` | Refund request for {course}: {status}. | ለ{course} የቀረበ የተመላሽ ገንዘብ ጥያቄ፦ {status}። |
| `refund_outcome_why` | Refund request for {course}: {status} ({why}). | ለ{course} የቀረበ የተመላሽ ገንዘብ ጥያቄ፦ {status} ({why})። |
| `refund` | Refund | ተመላሽ |
| `refund_rule_auto_approve_under_20pct_within_7d` | under 20% watched, within 7 days | ከ20% በታች የታየ፣ በ7 ቀናት ውስጥ |
| `refund_rule_manual_review_20_to_50pct` | 20–50% watched, so our team reviews it | ከ20–50% የታየ፣ ስለዚህ ቡድናችን ይገመግመዋል |
| `refund_rule_over_50pct_consumed` | more than half of the course watched | ከኮርሱ ከግማሽ በላይ የታየ |
| `refund_rule_outside_7_day_window` | more than 7 days since you enrolled | ከተመዘገቡ ከ7 ቀናት በላይ ሆኗል |
| `refund_rule_certificate_already_issued` | a certificate was already issued | ሰርተፊኬት አስቀድሞ ተሰጥቷል |
| `refund_rule_assessment_already_passed` | an assessment was already passed | ፈተና አስቀድሞ ተላልፏል |
| `at_least_n_chars` | At least {n} characters. | ቢያንስ {n} ቁምፊዎች። |
| `wallet` | Wallet | ዋሌት |
| `amount_pending` | +{amount} pending | +{amount} በመጠባበቅ ላይ |
| `cashback_info` | Earn {n}% cashback on every purchase · spend credits on any course | በእያንዳንዱ ግዢ {n}% ተመላሽ ያግኙ · ክሬዲቶችን በማንኛውም ኮርስ ይጠቀሙ |
| `topup_amount` | Top-up amount (ETB) | የመሙያ መጠን (ብር) |
| `topup_chapa` | Top up with Chapa | በቻፓ ሙላ |
| `available_on` | Available {date} | ከ{date} ጀምሮ ይገኛል |
| `wallet_kind_topup` | Top-up | መሙላት |
| `wallet_kind_purchase` | Course purchase | የኮርስ ግዢ |
| `wallet_kind_referral_reward` | Referral reward | የግብዣ ሽልማት |
| `wallet_kind_cashback` | Cashback | ተመላሽ |
| `wallet_kind_gift_sent` | Gift sent | የተላከ ስጦታ |
| `wallet_kind_admin_adjust` | Adjustment | ማስተካከያ |

## Catalog; header; notifications

| Key | English | Amharic draft |
|---|---|---|
| `sort_top` | Recommended | የሚመከሩ |
| `sort_new` | Newest | አዲስ |
| `sort_popular` | Most popular | በጣም ተወዳጅ |
| `sort_price_asc` | Price: low to high | ዋጋ፦ ከዝቅተኛ ወደ ከፍተኛ |
| `sort_price_desc` | Price: high to low | ዋጋ፦ ከከፍተኛ ወደ ዝቅተኛ |
| `sort_by` | Sort by | ደርድር በ |
| `remove_filter` | Remove {label} | {label} አስወግድ |
| `clear_search` | Clear search | ፍለጋውን አጽዳ |
| `filters` | Filters | ማጣሪያዎች |
| `filters_active` | Filters ({n} active) | ማጣሪያዎች ({n} ንቁ) |
| `no_courses_on_page` | No courses on this page | በዚህ ገጽ ላይ ኮርስ የለም |
| `showing_range` | Showing {from}–{to} of {total} courses | ከ{total} ኮርሶች {from}–{to} በማሳየት ላይ |
| `pagination` | Pagination | ገጾች |
| `menu` | Menu | ምናሌ |
| `notifications` | Notifications | ማሳወቂያዎች |
| `mark_all_read` | Mark all read | ሁሉንም እንደተነበበ ምልክት አድርግ |
| `no_notifications` | No notifications yet. | እስካሁን ምንም ማሳወቂያ የለም። |

## English-only notice (untranslated pages)

| Key | English | Amharic draft |
|---|---|---|
| `locale_notice` | This page is in English for now. | ይህ ገጽ ለጊዜው በእንግሊዝኛ ብቻ ነው። |
| `dismiss` | Dismiss | ዝጋ |
