import type { Lang } from '../i18n'

/** The studio's health questionnaire and declaration, verbatim in Arabic
 *  (the studio's own document) and translated to Hebrew. Second person
 *  feminine, as written by the studio. Answer CODES are shared; only the
 *  labels differ, so the admin reads any form in her own language. */
export type HealthText = {
  title: string
  intro: string
  yes: string
  no: string
  none: string
  other: string
  details: string
  ifYes: string
  s1: { title: string; fullName: string; birthDate: string; phone: string; exercises: string }
  s2: { title: string; q: string; noPain: string; areasQ: string; areas: Record<string, string>; level: string; since: string }
  s3: { title: string; q: string; options: Record<string, string>; details: string }
  s4: { title: string; q: string; type: string; area: string; when: string; limits: string }
  s5: { title: string; q: string; options: Record<string, string> }
  s6: { title: string; q: string; options: Record<string, string>; details: string }
  s7: { title: string; pregnant: string; postpartum: string; birthApprox: string; complications: string }
  s8: { title: string; meds: string; doctor: string }
  s9: { title: string; q: string }
  consent: { title: string; p: string[]; name: string; signature: string; signHint: string; clear: string; date: string; check: string; submit: string }
  errors: { name: string; birth: string; signature: string; check: string; answerAll: string; painLevel: string }
  view: { flags: string; noFlags: string; submitted: string; signedBy: string; readOnly: string; declared: string; missing: string }
  flags: Record<string, string>
}

export const AREA_ORDER = ['neck', 'shoulders', 'upper_back', 'lower_back', 'pelvis', 'hip', 'knee', 'ankle_foot', 'wrist_hand', 'other']
export const SPINE_ORDER = ['disc_herniation', 'disc_bulge', 'chronic_low_back', 'neck_pain', 'sciatica', 'scoliosis', 'posture', 'osteoporosis', 'spine_injury', 'none']
export const JOINT_ORDER = ['knee', 'hip', 'shoulder', 'elbow', 'wrist_hand', 'ankle_foot', 'arthritis', 'weakness', 'limited', 'other', 'none']
export const COND_ORDER = ['osteoporosis', 'heart_bp', 'breathing', 'dizziness', 'hernia', 'chronic', 'other', 'none']

export const HEALTH: Record<Lang, HealthText> = {
  he: {
    title: 'שאלון בריאות והצהרת השתתפות בשיעורי Pilates',
    intro: 'נא למלא את השאלון בקפידה לפני ההשתתפות בשיעורי Pilates. המידע נועד לסייע למדריכה להבין את מצבך הבריאותי ולהתאים את התרגילים בהתאם.',
    yes: 'כן', no: 'לא', none: 'אין', other: 'אחר', details: 'פרטים נוספים', ifYes: 'אם כן, נא לפרט:',
    s1: { title: 'פרטים אישיים', fullName: 'שם מלא', birthDate: 'תאריך לידה', phone: 'מספר טלפון', exercises: 'האם את מתאמנת באופן קבוע?' },
    s2: {
      title: 'כאב נוכחי',
      q: 'האם את סובלת כעת מכאב או אי־נוחות בגוף?',
      noPain: 'אין כאב',
      areasQ: 'אם כן, נא לסמן את מיקום הכאב:',
      areas: { neck: 'הצוואר', shoulders: 'הכתפיים', upper_back: 'הגב העליון', lower_back: 'הגב התחתון', pelvis: 'האגן', hip: 'מפרק הירך', knee: 'הברך', ankle_foot: 'הקרסול / כף הרגל', wrist_hand: 'שורש כף היד / היד', other: 'אזור אחר' },
      level: 'דרגת הכאב מ־0 עד 10',
      since: 'מאז מתי החל הכאב?',
    },
    s3: {
      title: 'הגב ועמוד השדרה',
      q: 'האם יש לך, או היה לך בעבר, אחד מהמצבים הבאים?',
      options: { disc_herniation: 'פריצת דיסק', disc_bulge: 'בלט דיסק', chronic_low_back: 'כאב כרוני בגב התחתון', neck_pain: 'כאב בצוואר', sciatica: 'סיאטיקה (עצב השת)', scoliosis: 'עקמת / עיקום בעמוד השדרה', posture: 'גיבנת או בעיה ביציבת עמוד השדרה', osteoporosis: 'אוסטאופורוזיס או חולשת עצם', spine_injury: 'שבר או פציעה קודמת בעמוד השדרה', none: 'אין' },
      details: 'פרטים נוספים',
    },
    s4: { title: 'פציעות וניתוחים', q: 'האם נפצעת בעבר או עברת ניתוח שעשוי להשפיע על התנועה או על התרגילים?', type: 'סוג הפציעה / הניתוח', area: 'האזור', when: 'מתי זה קרה?', limits: 'האם קיים כעת כאב או מוגבלות בתנועה?' },
    s5: {
      title: 'מפרקים ושרירים',
      q: 'האם יש לך בעיה או אבחנה הקשורה למפרקים או לשרירים?',
      options: { knee: 'הברך', hip: 'מפרק הירך', shoulder: 'הכתף', elbow: 'המרפק', wrist_hand: 'שורש כף היד / היד', ankle_foot: 'הקרסול / כף הרגל', arthritis: 'דלקת או כאב כרוני במפרקים', weakness: 'חולשת שרירים', limited: 'מוגבלות בתנועה', other: 'אחר', none: 'אין' },
    },
    s6: {
      title: 'מצבים בריאותיים נוספים',
      q: 'האם את סובלת ממצב בריאותי שעשוי להשפיע על יכולתך להתאמן?',
      options: { osteoporosis: 'אוסטאופורוזיס', heart_bp: 'בעיות לב או לחץ דם', breathing: 'בעיות נשימה', dizziness: 'סחרחורת או אובדן שיווי משקל חוזר', hernia: 'בקע', chronic: 'מחלה כרונית', other: 'מצב בריאותי אחר', none: 'אין' },
      details: 'אם כן, נא לפרט:',
    },
    s7: { title: 'היריון ואחרי לידה', pregnant: 'האם את בהיריון כעת?', postpartum: 'האם ילדת ב־12 החודשים האחרונים?', birthApprox: 'אם כן, נא לציין תאריך לידה משוער:', complications: 'האם יש לך סיבוכים או המלצות רפואיות הקשורות להיריון או ללידה?' },
    s8: { title: 'תרופות והמלצות רפואיות', meds: 'האם את נוטלת תרופות באופן קבוע שעשויות להשפיע על יכולתך להתאמן?', doctor: 'האם רופא או גורם מקצועי ביקש ממך להימנע מפעילות גופנית או מתנועה מסוימת?' },
    s9: { title: 'מידע נוסף', q: 'האם יש משהו נוסף הקשור לבריאותך או לגופך שהמדריכה צריכה לדעת לפני תחילת השיעור?' },
    consent: {
      title: 'הצהרה והסכמה',
      p: [
        'אני מצהירה כי המידע שמסרתי בשאלון זה נכון ומלא למיטב ידיעתי, וכי אעדכן את המדריכה על כל שינוי במצבי הבריאותי או על הופעת כאב או תסמינים חדשים.',
        'אני מבינה כי שיעורי Pilates הם פעילות גופנית ואינם אבחון או טיפול רפואי, וכי המדריכה אינה תחליף לרופא או לפיזיותרפיסט.',
        'אני מבינה כי במקרה של מצב בריאותי, פציעה או כאב שעשויים להשפיע על יכולתי להתאמן, ייתכן שאתבקש להציג אישור או המלצה רפואית לפני ההשתתפות או לפני המשך ביצוע תרגילים מסוימים.',
        'אני מתחייבת להודיע למדריכה מיד במהלך השיעור אם ארגיש כאב לא רגיל, סחרחורת, קוצר נשימה או כל תסמין מדאיג.',
      ],
      name: 'שם מלא', signature: 'חתימה אלקטרונית', signHint: 'חתמי כאן באצבע', clear: 'ניקוי', date: 'תאריך',
      check: 'אני מאשרת שקראתי והבנתי את המידע לעיל ומסכימה להשתתף בשיעורי Pilates בהתאם לכך.',
      submit: 'שליחת ההצהרה',
    },
    errors: { name: 'נא למלא שם מלא', birth: 'נא למלא תאריך לידה', signature: 'נא לחתום', check: 'נא לאשר את ההצהרה', answerAll: 'נא לענות על כל השאלות', painLevel: 'נא לציין את דרגת הכאב' },
    view: { flags: 'שימו לב', noFlags: 'ללא ממצאים', submitted: 'נמסרה ב־{d}', signedBy: 'נחתם על ידי {n}', readOnly: 'מולא על ידי המתאמנת באפליקציה — לקריאה בלבד. עדכון נעשה רק על ידה.', declared: 'קראה ואישרה את ההצהרה', missing: 'לא מולאה' },
    flags: { pain: 'כאב נוכחי', spine: 'עמוד השדרה', injury: 'פציעה / ניתוח', joints: 'מפרקים / שרירים', conditions: 'מצב בריאותי', pregnant: 'היריון', postpartum: 'אחרי לידה', medication: 'תרופות', doctor_restriction: 'הגבלה רפואית', other: 'מידע נוסף' },
  },
  ar: {
    title: 'استبيان الحالة الصحية والإقرار بالمشاركة في جلسات Pilates',
    intro: 'يرجى تعبئة الاستبيان بدقة قبل المشاركة في جلسات Pilates. تهدف هذه المعلومات إلى مساعدة المدربة على فهم حالتك الصحية وتعديل التمارين بما يتناسب مع حالتك.',
    yes: 'نعم', no: 'لا', none: 'لا يوجد', other: 'أخرى', details: 'تفاصيل إضافية', ifYes: 'إذا كانت الإجابة نعم، يرجى التوضيح:',
    s1: { title: 'المعلومات الشخصية', fullName: 'الاسم الكامل', birthDate: 'تاريخ الميلاد', phone: 'رقم الهاتف', exercises: 'هل تمارسين الرياضة بشكل منتظم؟' },
    s2: {
      title: 'الألم الحالي',
      q: 'هل تعانين حاليًا من أي ألم أو انزعاج في الجسم؟',
      noPain: 'لا يوجد ألم',
      areasQ: 'إذا كانت الإجابة نعم، يرجى تحديد مكان الألم:',
      areas: { neck: 'الرقبة', shoulders: 'الكتفين', upper_back: 'أعلى الظهر', lower_back: 'أسفل الظهر', pelvis: 'الحوض', hip: 'الورك', knee: 'الركبة', ankle_foot: 'الكاحل / القدم', wrist_hand: 'الرسغ / اليد', other: 'منطقة أخرى' },
      level: 'درجة الألم من 0 إلى 10',
      since: 'منذ متى بدأ الألم؟',
    },
    s3: {
      title: 'الظهر والعمود الفقري',
      q: 'هل لديكِ أو سبق أن عانيتِ من أي من الحالات التالية؟',
      options: { disc_herniation: 'انزلاق غضروفي (ديسك)', disc_bulge: 'بروز غضروفي', chronic_low_back: 'ألم مزمن في أسفل الظهر', neck_pain: 'ألم في الرقبة', sciatica: 'عرق النسا', scoliosis: 'جنف / انحناء في العمود الفقري', posture: 'تحدب أو مشكلة في وضعية العمود الفقري', osteoporosis: 'هشاشة أو ضعف في العظام', spine_injury: 'كسر أو إصابة سابقة في العمود الفقري', none: 'لا يوجد' },
      details: 'تفاصيل إضافية',
    },
    s4: { title: 'الإصابات والعمليات الجراحية', q: 'هل تعرضتِ سابقًا لإصابة أو خضعتِ لعملية جراحية يمكن أن تؤثر على الحركة أو التمارين؟', type: 'نوع الإصابة / العملية', area: 'المنطقة', when: 'متى حدثت؟', limits: 'هل يوجد حاليًا أي ألم أو محدودية في الحركة؟' },
    s5: {
      title: 'المفاصل والعضلات',
      q: 'هل لديكِ أي مشكلة أو تشخيص متعلق بالمفاصل أو العضلات؟',
      options: { knee: 'الركبة', hip: 'الورك', shoulder: 'الكتف', elbow: 'الكوع', wrist_hand: 'الرسغ / اليد', ankle_foot: 'الكاحل / القدم', arthritis: 'التهاب أو ألم مزمن في المفاصل', weakness: 'ضعف عضلي', limited: 'محدودية في الحركة', other: 'أخرى', none: 'لا يوجد' },
    },
    s6: {
      title: 'حالات صحية أخرى',
      q: 'هل تعانين من أي حالة صحية قد تؤثر على قدرتك على ممارسة التمارين؟',
      options: { osteoporosis: 'هشاشة العظام', heart_bp: 'مشاكل في القلب أو ضغط الدم', breathing: 'مشاكل في التنفس', dizziness: 'دوخة أو فقدان توازن متكرر', hernia: 'فتق', chronic: 'مرض مزمن', other: 'حالة صحية أخرى', none: 'لا يوجد' },
      details: 'إذا كانت الإجابة نعم، يرجى التوضيح:',
    },
    s7: { title: 'الحمل وما بعد الولادة', pregnant: 'هل أنتِ حامل حاليًا؟', postpartum: 'هل ولدتِ خلال الأشهر الـ12 الماضية؟', birthApprox: 'إذا كانت الإجابة نعم، يرجى ذكر تاريخ الولادة التقريبي:', complications: 'هل لديكِ أي مضاعفات أو توصيات طبية مرتبطة بالحمل أو الولادة؟' },
    s8: { title: 'الأدوية والتوصيات الطبية', meds: 'هل تتناولين أدوية بشكل منتظم قد تؤثر على قدرتك على ممارسة الرياضة؟', doctor: 'هل طلب منكِ طبيب أو مختص طبي تجنب نشاط رياضي أو حركة معينة؟' },
    s9: { title: 'معلومات إضافية', q: 'هل يوجد أي شيء آخر يتعلق بصحتك أو جسمك يجب أن تعرفه المدربة قبل بدء الجلسة؟' },
    consent: {
      title: 'الإقرار والموافقة',
      p: [
        'أقر بأن المعلومات التي قدمتها في هذا الاستبيان صحيحة وكاملة حسب علمي، وأنني سأقوم بإبلاغ المدربة عن أي تغيير في حالتي الصحية أو ظهور ألم أو أعراض جديدة.',
        'أفهم أن جلسات Pilates هي نشاط بدني وليست تشخيصًا أو علاجًا طبيًا، وأن المدربة ليست بديلًا عن الطبيب أو أخصائي العلاج الطبيعي.',
        'أفهم أنه في حال وجود حالة صحية أو إصابة أو ألم قد يؤثر على قدرتي على ممارسة التمارين، قد يُطلب مني الحصول على موافقة أو توصية طبية قبل المشاركة أو الاستمرار في بعض التمارين.',
        'ألتزم بإبلاغ المدربة فورًا أثناء الجلسة في حال شعرت بألم غير معتاد، دوخة، ضيق في التنفس أو أي أعراض مقلقة.',
      ],
      name: 'الاسم الكامل', signature: 'التوقيع الإلكتروني', signHint: 'امضي هنا بإصبعك', clear: 'مسح', date: 'التاريخ',
      check: 'أؤكد أنني قرأت وفهمت المعلومات أعلاه وأوافق على المشاركة في جلسات Pilates وفقًا لها.',
      submit: 'إرسال الإقرار',
    },
    errors: { name: 'يرجى إدخال الاسم الكامل', birth: 'يرجى إدخال تاريخ الميلاد', signature: 'يرجى التوقيع', check: 'يرجى تأكيد الإقرار', answerAll: 'يرجى الإجابة على كل الأسئلة', painLevel: 'يرجى تحديد درجة الألم' },
    view: { flags: 'انتبهوا', noFlags: 'بدون ملاحظات', submitted: 'قُدّم بتاريخ {d}', signedBy: 'وقّعته {n}', readOnly: 'عبّأته المتدربة بالتطبيق — للقراءة فقط. التحديث بس من طرفها.', declared: 'قرأت الإقرار وأكّدته', missing: 'غير معبّأ' },
    flags: { pain: 'ألم حالي', spine: 'العمود الفقري', injury: 'إصابة / عملية', joints: 'مفاصل / عضلات', conditions: 'حالة صحية', pregnant: 'حمل', postpartum: 'بعد الولادة', medication: 'أدوية', doctor_restriction: 'قيد طبي', other: 'معلومات إضافية' },
  },
}
