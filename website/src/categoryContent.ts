export type StoryLocale = 'en' | 'he'

export type ToolAvailability = 'execution' | 'review' | 'adapter' | 'runtime'

export interface LocalizedText {
  en: string
  he: string
}

export interface LocalizedList {
  en: string[]
  he: string[]
}

export interface ToolStory {
  id: string
  name: LocalizedText
  summary: LocalizedText
  mode: 'local' | 'hybrid' | 'cloud' | 'review'
  availability: ToolAvailability
  input: LocalizedText
  action: LocalizedText
  output: LocalizedText
  savings: LocalizedText
  limitation: LocalizedText
}

export interface CategoryStory {
  id: 'footage' | 'image' | 'video' | 'motion' | 'audio'
  index: string
  color: string
  name: LocalizedText
  kicker: LocalizedText
  title: LocalizedText
  intro: LocalizedText
  sources: LocalizedList
  returns: LocalizedList
  savings: LocalizedList
  pipeline: {
    source: LocalizedText
    process: LocalizedText
    result: LocalizedText
  }
  tools: ToolStory[]
}

export const categoryStories: CategoryStory[] = [
  {
    id: 'footage',
    index: '01',
    color: '#AAB2C4',
    name: { en: 'Footage AI', he: 'חומרי גלם' },
    kicker: { en: 'REVIEW · COVERAGE · QUALITY', he: 'סקירה · כיסוי · איכות' },
    title: {
      en: 'Understand the source before you generate anything.',
      he: 'מבינים את חומר הגלם לפני שמייצרים משהו חדש.',
    },
    intro: {
      en: 'Bring the clip under the playhead, the visible trim, Library media or an upload into one controlled review surface. Keep review-only recipes honest, and enhance only the versions you approve.',
      he: 'מביאים למשטח עבודה אחד את הקליפ שמתחת ל־playhead, את החיתוך הנראה בטיימליין, מדיה מהספרייה או קובץ. מתכוני Review נשארים שקופים, ורק גרסאות שאישרתם ממשיכות הלאה.',
    },
    sources: {
      en: ['The exact trimmed video under the playhead', 'Images and clips from the local Library', 'Mixed image/video upload batches'],
      he: ['קליפ הווידאו לפי ה־In/Out הנראה בטיימליין', 'תמונות וקליפים מהספרייה המקומית', 'Batch מעורב של תמונות ווידאו'],
    },
    returns: {
      en: ['Reviewed assets remain in the local Library', 'Approved upscale results can go to Media Pool or timeline', 'Source media is never silently replaced'],
      he: ['נכסים שנבדקו נשארים בספרייה המקומית', 'תוצאות Upscale מאושרות נשלחות ל־Media Pool או לטיימליין', 'חומר המקור לעולם אינו מוחלף בשקט'],
    },
    savings: {
      en: ['No export and re-trim loop for upscale', 'One place for source context and review notes', 'Batch images and video without rebuilding each job'],
      he: ['אין סבב export וחיתוך מחדש לפני Upscale', 'הקשר המקור והחלטות הסקירה נשארים במקום אחד', 'מריצים תמונות ווידאו כ־Batch בלי לבנות כל משימה מחדש'],
    },
    pipeline: {
      source: { en: 'Visible trim', he: 'החיתוך הנראה' },
      process: { en: 'Review or enhance', he: 'בדיקה או שיפור' },
      result: { en: 'Approved media', he: 'מדיה מאושרת' },
    },
    tools: [
      {
        id: 'culling',
        name: { en: 'Culling', he: 'מיון חומרי גלם' },
        summary: { en: 'Define a conservative Keep / Maybe / Reject review.', he: 'הגדרת סקירה שמרנית של Keep / Maybe / Reject.' },
        mode: 'review',
        availability: 'review',
        input: { en: 'A video file, Library item or one clip under the playhead.', he: 'קובץ וידאו, פריט מהספרייה או קליפ יחיד מתחת ל־playhead.' },
        action: { en: 'Structures review criteria and source context for an approved selects workflow.', he: 'מרכז קריטריונים למיון והקשר מקור לקראת תהליך Selects מאושר.' },
        output: { en: 'Workflow review only in the current build; no automatic selects timeline or metadata changes.', he: 'כרגע מתקבל Review בלבד; אין יצירת Selects Timeline או שינוי Metadata.' },
        savings: { en: 'Keeps criteria and footage context together instead of rebuilding the brief elsewhere.', he: 'שומר את קריטריוני המיון והחומר יחד, בלי לבנות מחדש בריף באפליקציה אחרת.' },
        limitation: { en: 'Review only — do not treat it as automatic footage analysis yet.', he: 'Review בלבד — עדיין לא ניתוח אוטומטי של שעות חומר.' },
      },
      {
        id: 'b-roll',
        name: { en: 'B-roll', he: 'בי־רול' },
        summary: { en: 'Plan missing coverage around the current editorial context.', he: 'תכנון כיסוי חסר סביב ההקשר העריכתי הנוכחי.' },
        mode: 'review',
        availability: 'review',
        input: { en: 'Video or transcript files, Library video, or the current timeline clip.', he: 'וידאו או Transcript מקובץ, וידאו מהספרייה או הקליפ הנוכחי בטיימליין.' },
        action: { en: 'Builds a reviewed recipe for coverage needs and shot suggestions.', he: 'בונה מתכון לבדיקה עבור צורכי כיסוי והצעות לשוטים.' },
        output: { en: 'A reviewable brief; no automatic project search, gap fill or placement in the current build.', he: 'בריף שניתן לבדיקה; אין עדיין חיפוש בפרויקט, מילוי gap או הצבה.' },
        savings: { en: 'Shortens source gathering and brief preparation without claiming a completed edit.', he: 'מקצר את איסוף המקורות והכנת הבריף בלי להציג עריכה שלא בוצעה.' },
        limitation: { en: 'Review only — automated B-roll matching is not enabled.', he: 'Review בלבד — התאמת בי־רול אוטומטית אינה פעילה.' },
      },
      {
        id: 'upscale',
        name: { en: 'Upscale', he: 'שיפור רזולוציה' },
        summary: { en: 'Enhance mixed image and trimmed-video batches non-destructively.', he: 'שיפור Batch מעורב של תמונות ווידאו חתוך, ללא שינוי המקור.' },
        mode: 'cloud',
        availability: 'adapter',
        input: { en: 'Images and videos from Upload or Library, plus one exact timeline Grab at a time.', he: 'תמונות ווידאו מ־Upload או מהספרייה, וגם Grab מדויק אחד בכל פעם מהטיימליין.' },
        action: { en: 'Routes each item to the verified image or video upscale path with a per-item factor.', he: 'מפנה כל פריט לנתיב שיפור תמונה או וידאו מאומת, עם factor נפרד.' },
        output: { en: 'Partial successes are kept in Library and approved results can be sent to Media Pool or timeline.', he: 'גם הצלחות חלקיות נשמרות בספרייה, ותוצאות מאושרות נשלחות ל־Media Pool או לטיימליין.' },
        savings: { en: 'Removes manual export, endpoint trimming, separate runs and re-import.', he: 'מבטל export ידני, חיתוך endpoint, הרצות נפרדות וייבוא חוזר.' },
        limitation: { en: 'Requires a verified Topaz Cloud adapter and an active account.', he: 'דורש מתאם Topaz Cloud מאומת וחשבון פעיל.' },
      },
    ],
  },
  {
    id: 'image',
    index: '02',
    color: '#EA73D4',
    name: { en: 'Image AI', he: 'תמונה' },
    kicker: { en: 'FRAMES · BOARDS · CHARACTERS', he: 'פריימים · סטוריבורד · דמויות' },
    title: {
      en: 'Turn the frame you are editing into the next visual decision.',
      he: 'הופכים את הפריים שכבר בעריכה להחלטה הוויזואלית הבאה.',
    },
    intro: {
      en: 'Capture a source frame at the playhead, combine it with Library references and move from generation to comparison without exporting stills or losing visual context.',
      he: 'לוכדים פריים מה־playhead, משלבים רפרנסים מהספרייה ועוברים מיצירה להשוואה בלי לייצא stills ובלי לאבד הקשר חזותי.',
    },
    sources: {
      en: ['Frame captured at the current playhead', 'Upload and local Library references', 'Structured story or character direction'],
      he: ['פריים שנלכד בנקודת ה־playhead', 'רפרנסים מ־Upload ומהספרייה המקומית', 'בריף מובנה לסיפור או לדמות'],
    },
    returns: {
      en: ['Every variation is stored in the local Library', 'Only selected images go back to Resolve', 'Transparent PNG for background removal when supported'],
      he: ['כל וריאציה נשמרת בספרייה המקומית', 'רק תמונות שבחרתם חוזרות ל־Resolve', 'PNG שקוף ב־Remove Background כאשר הנתיב נתמך'],
    },
    savings: {
      en: ['No still export before using a reference', 'No repeated prompt and reference setup between tools', 'Compare, approve and place from the same surface'],
      he: ['אין צורך לייצא Still לפני שימוש כרפרנס', 'לא בונים מחדש פרומפט ורפרנסים בין כלים', 'משווים, מאשרים ומציבים מאותו משטח עבודה'],
    },
    pipeline: {
      source: { en: 'Playhead frame', he: 'פריים מה־playhead' },
      process: { en: 'Create or transform', he: 'יצירה או שינוי' },
      result: { en: 'Selected still', he: 'סטיל שנבחר' },
    },
    tools: [
      {
        id: 'create-image',
        name: { en: 'Create Image', he: 'יצירת תמונה' },
        summary: { en: 'Generate stills from direction, style and visual references.', he: 'יצירת סטילס מהנחיה, סגנון ורפרנסים חזותיים.' },
        mode: 'cloud',
        availability: 'execution',
        input: { en: 'Prompt, model settings and images from Upload or a playhead frame.', he: 'פרומפט, הגדרות מודל ותמונות מ־Upload או מפריים בטיימליין.' },
        action: { en: 'Generates multiple candidates while preserving the selected source context.', he: 'מייצר מספר מועמדים תוך שמירת הקשר המקור שנבחר.' },
        output: { en: 'Variations in Library; only marked images are sent to Resolve using the chosen placement.', he: 'וריאציות בספרייה; רק תמונות מסומנות נשלחות ל־Resolve לפי מצב ההצבה.' },
        savings: { en: 'Connects reference capture, generation, comparison and import in one window.', he: 'מחבר לכידת רפרנס, יצירה, השוואה וייבוא בחלון אחד.' },
        limitation: { en: 'Established execution path; public customer access remains release-dependent.', he: 'נתיב ביצוע קיים; הגישה הציבורית עדיין תלויה בגרסת ההפצה.' },
      },
      {
        id: 'storyboard',
        name: { en: 'Storyboard', he: 'סטוריבורד' },
        summary: { en: 'Build an editable scene plan, candidates and one approved board.', he: 'בניית תכנית סצנות, מועמדים ולוח מאושר אחד.' },
        mode: 'hybrid',
        availability: 'adapter',
        input: { en: 'Story brief, scene lines, timing and references from Upload, Library or Grab Frame.', he: 'בריף, שורות סצנה, תזמון ורפרנסים מ־Upload, מהספרייה או מ־Grab Frame.' },
        action: { en: 'Plans up to a reviewed scene sequence, generates candidates and tracks approval per frame.', he: 'מתכנן רצף סצנות לבדיקה, יוצר מועמדים ועוקב אחרי אישור לכל פריים.' },
        output: { en: 'Approved frames plus a 1920px complete-board PNG; no timeline placement yet.', he: 'פריימים מאושרים ו־PNG אחד של הלוח המלא ברוחב 1920px; עדיין ללא הצבה בטיימליין.' },
        savings: { en: 'Combines planning, continuity, candidate review and board export without a document/tool shuffle.', he: 'מאחד תכנון, continuity, סקירת מועמדים וייצוא לוח בלי לדלג בין מסמכים וכלים.' },
        limitation: { en: 'Selected-range-to-storyboard is not connected to Resolve yet.', he: 'המרת טווח מסומן לסטוריבורד עדיין אינה מחוברת ל־Resolve.' },
      },
      {
        id: 'character',
        name: { en: 'Character', he: 'דמות' },
        summary: { en: 'Create a structured character brief with identity references.', he: 'בניית בריף דמות מובנה עם רפרנסים לזהות.' },
        mode: 'cloud',
        availability: 'adapter',
        input: { en: 'Structured appearance fields and up to three samples, including a grabbed frame.', he: 'שדות מראה מובנים ועד שלוש דוגמאות, כולל פריים שנלכד מהטיימליין.' },
        action: { en: 'Compiles reusable character direction, a primary reference and identity strength.', he: 'מרכיב הנחיית דמות חוזרת, רפרנס ראשי ועוצמת זהות.' },
        output: { en: 'Character variations in Library with selective placement back to Resolve.', he: 'וריאציות דמות בספרייה, עם הצבה סלקטיבית חזרה ל־Resolve.' },
        savings: { en: 'Replaces repeated long prompts and manual reference management with a saved structure.', he: 'מחליף פרומפטים ארוכים חוזרים וניהול ידני של רפרנסים במבנה שמור.' },
        limitation: { en: 'Model-dependent; visual identity consistency is guided, not guaranteed.', he: 'תלוי במודל; עקביות זהות מונחית אך אינה מובטחת.' },
      },
      {
        id: 'edit-image',
        name: { en: 'Edit Image', he: 'עריכת תמונה' },
        summary: { en: 'Prompt edit, inpaint, upscale or remove a background non-destructively.', he: 'Prompt Edit, ‏Inpaint, ‏Upscale או הסרת רקע ללא שינוי המקור.' },
        mode: 'cloud',
        availability: 'execution',
        input: { en: 'A Library/upload image or source under the playhead, with optional references and mask.', he: 'תמונה מהספרייה/Upload או מקור מתחת ל־playhead, עם רפרנסים ו־Mask אופציונליים.' },
        action: { en: 'Transforms the full image or only the painted mask while retaining the original.', he: 'משנה את התמונה כולה או רק את אזור ה־Mask, תוך שמירת המקור.' },
        output: { en: 'A new Library asset; background removal can return transparent PNG.', he: 'נכס חדש בספרייה; הסרת רקע יכולה להחזיר PNG שקוף.' },
        savings: { en: 'Removes still export, external masking and re-import from the edit loop.', he: 'מבטל ייצוא Still, עבודה בכלי Mask חיצוני וייבוא מחדש.' },
        limitation: { en: 'Established execution path; exact options vary by verified model.', he: 'נתיב ביצוע קיים; האפשרויות המדויקות משתנות לפי המודל המאומת.' },
      },
      {
        id: 'angles',
        name: { en: 'Angles', he: 'זוויות מצלמה' },
        summary: { en: 'Explore alternate coverage from one locked source image.', he: 'בחינת כיסוי חלופי מתמונת מקור אחת נעולה.' },
        mode: 'cloud',
        availability: 'adapter',
        input: { en: 'One uploaded image or frame/source under the playhead, plus optional camera direction.', he: 'תמונה אחת שהועלתה או פריים/מקור מה־playhead, עם הנחיית מצלמה אופציונלית.' },
        action: { en: 'Creates a random coverage set or a specifically directed viewpoint.', he: 'יוצר סט כיסוי אקראי או נקודת מבט מוגדרת במדויק.' },
        output: { en: 'Separate views in Library; only approved angles are placed.', he: 'זוויות נפרדות בספרייה; רק הזוויות המאושרות מוצבות.' },
        savings: { en: 'Avoids exporting one frame, rebuilding references and importing every variation.', he: 'חוסך ייצוא פריים, בנייה מחדש של רפרנסים וייבוא כל וריאציה.' },
        limitation: { en: 'Cloud adapter-dependent; subject identity cannot be promised perfectly.', he: 'תלוי במתאם ענן; אין הבטחה לשימור זהות מושלם.' },
      },
    ],
  },
  {
    id: 'video',
    index: '03',
    color: '#719BFF',
    name: { en: 'Video AI', he: 'וידאו' },
    kicker: { en: 'GENERATE · TRANSFORM · CONNECT', he: 'יצירה · שינוי · חיבור' },
    title: {
      en: 'New shots that inherit the context of your edit.',
      he: 'שוטים חדשים שמקבלים את ההקשר מהעריכה עצמה.',
    },
    intro: {
      en: 'Use frames, trimmed clips, audio and rendered shot boundaries as model inputs. Takes remain reviewable in Library, and timeline placement happens only after you choose a version.',
      he: 'משתמשים בפריימים, קליפים חתוכים, אודיו וגבולות שוט מרונדרים כקלט למודל. כל Take נשאר לבדיקה בספרייה, והצבה מתבצעת רק אחרי בחירת גרסה.',
    },
    sources: {
      en: ['Playhead frames, exact trimmed clips and audio', 'Rendered end/start frames for shot boundaries', 'Upload and Library references'],
      he: ['פריימים, קליפים חתוכים ואודיו מהטיימליין', 'פריימים מרונדרים של סוף/תחילת שוטים', 'רפרנסים מ־Upload ומהספרייה'],
    },
    returns: {
      en: ['All takes are materialized in Library first', 'Chosen clips use Media Pool, playhead or append placement', 'Transition placement revalidates the original cut'],
      he: ['כל ה־Takes נשמרים קודם בספרייה', 'קליפים נבחרים נשלחים ל־Media Pool, ל־playhead או ל־Append', 'הצבת Transition מאמתת מחדש את החיתוך המקורי'],
    },
    savings: {
      en: ['No endpoint still export for transitions or extensions', 'No manual re-trim before model upload', 'Review alternatives before adding timeline media'],
      he: ['אין ייצוא Still של endpoints ל־Transition או Extend', 'אין חיתוך ידני מחדש לפני העלאה למודל', 'בודקים חלופות לפני הוספת מדיה לטיימליין'],
    },
    pipeline: {
      source: { en: 'Frame / clip / audio', he: 'פריים / קליפ / אודיו' },
      process: { en: 'Generate or transform', he: 'יצירה או שינוי' },
      result: { en: 'Reviewed take', he: 'Take שנבדק' },
    },
    tools: [
      {
        id: 'create-video',
        name: { en: 'Create Video', he: 'יצירת וידאו' },
        summary: { en: 'Generate clips from text, endpoints and model-specific references.', he: 'יצירת קליפים מטקסט, endpoints ורפרנסים לפי יכולות המודל.' },
        mode: 'cloud',
        availability: 'execution',
        input: { en: 'Frames, images, clips and audio from Upload or timeline; supported models add shots or elements.', he: 'פריימים, תמונות, קליפים ואודיו מ־Upload או מהטיימליין; מודלים תומכים מוסיפים shots או elements.' },
        action: { en: 'Builds one or more takes from the approved source package and direction.', he: 'בונה Take אחד או יותר מחבילת המקורות וההנחיה שאושרו.' },
        output: { en: 'Previewable takes in Library with selective placement back to Resolve.', he: 'Takes ניתנים לצפייה בספרייה, עם הצבה סלקטיבית חזרה ל־Resolve.' },
        savings: { en: 'Keeps edit context attached from capture through generation, review and import.', he: 'שומר את הקשר העריכה מלכידה, דרך יצירה ובדיקה ועד ייבוא.' },
        limitation: { en: 'Established execution path; features and limits vary by verified model.', he: 'נתיב ביצוע קיים; היכולות והמגבלות משתנות לפי המודל המאומת.' },
      },
      {
        id: 'avatar',
        name: { en: 'Avatar', he: 'אווטאר' },
        summary: { en: 'Animate a portrait or lip-sync a trimmed source clip.', he: 'הנפשת פורטרט או Lip-sync לקליפ מקור חתוך.' },
        mode: 'cloud',
        availability: 'adapter',
        input: { en: 'Portrait or exact timeline video plus voice audio; rights and consent are required.', he: 'פורטרט או וידאו מדויק מהטיימליין יחד עם אודיו; נדרשת הצהרת זכויות והסכמה.' },
        action: { en: 'Uses the audio for words, timing and duration, with explicit subject choice when supported.', he: 'משתמש באודיו למילים, לתזמון ולאורך, עם בחירת דובר מפורשת כשנתמך.' },
        output: { en: 'A new video in Library that can be sent to the timeline after review.', he: 'וידאו חדש בספרייה שניתן לשלוח לטיימליין לאחר בדיקה.' },
        savings: { en: 'Removes intermediate-file prep, separate lip-sync tools and manual re-import.', he: 'מבטל הכנת קבצי ביניים, מעבר לכלי Lip-sync נפרד וייבוא חוזר.' },
        limitation: { en: 'Requires a verified avatar adapter, an active account and valid consent.', he: 'דורש מתאם Avatar מאומת, חשבון פעיל והסכמה תקפה.' },
      },
      {
        id: 'edit-video',
        name: { en: 'Edit Video', he: 'עריכת וידאו' },
        summary: { en: 'Transform the exact trimmed clip without touching the original.', he: 'שינוי הקליפ לפי החיתוך המדויק, בלי לגעת במקור.' },
        mode: 'cloud',
        availability: 'execution',
        input: { en: 'Visible timeline trim, Library item or upload, plus optional reference media.', he: 'החיתוך הנראה בטיימליין, פריט מהספרייה או Upload, עם מדיית רפרנס אופציונלית.' },
        action: { en: 'Applies a prompt transformation or verified video upscale to a new derivative.', he: 'מחיל שינוי בפרומפט או Video Upscale מאומת על נגזרת חדשה.' },
        output: { en: 'A new clip in Library; the original timeline source remains unchanged.', he: 'קליפ חדש בספרייה; מקור הטיימליין המקורי נשאר ללא שינוי.' },
        savings: { en: 'Uses the editor’s trim as the source of truth and removes export/re-import.', he: 'משתמש בחיתוך של העורך כמקור האמת ומבטל export/re-import.' },
        limitation: { en: 'Established execution path; cloud model access remains build-dependent.', he: 'נתיב ביצוע קיים; הגישה למודל הענן תלויה בגרסה.' },
      },
      {
        id: 'extend-video',
        name: { en: 'Extend Video', he: 'הארכת וידאו' },
        summary: { en: 'Continue forward from the rendered final frame of a shot.', he: 'המשך קדימה מהפריים המרונדר האחרון של השוט.' },
        mode: 'cloud',
        availability: 'adapter',
        input: { en: 'Rendered end frame under the playhead, with an optional target frame or reference video.', he: 'פריים מרונדר מסוף השוט מתחת ל־playhead, עם target frame או reference video אופציונליים.' },
        action: { en: 'Builds continuity direction around subject, light and camera movement.', he: 'בונה הנחיית המשכיות סביב subject, תאורה ותנועת מצלמה.' },
        output: { en: 'An extension in Library; placement is user-controlled and is not auto-attached to the clip edge.', he: 'Extension בספרייה; ההצבה בשליטת המשתמש ואינה נצמדת אוטומטית לקצה הקליפ.' },
        savings: { en: 'Provides the correct rendered boundary without a manual still-export loop.', he: 'מספק את גבול השוט המרונדר הנכון בלי סבב ייצוא Still ידני.' },
        limitation: { en: 'Forward adapters are planned; backward extension is not available.', he: 'מתאמי Forward מתוכננים; הארכה לאחור אינה זמינה.' },
      },
      {
        id: 'transition',
        name: { en: 'Transition', he: 'מעבר' },
        summary: { en: 'Generate a bridge from the two real sides of an existing cut.', he: 'יצירת גשר משני הצדדים האמיתיים של חיתוך קיים.' },
        mode: 'hybrid',
        availability: 'adapter',
        input: { en: 'Rendered outgoing end frame and incoming start frame from the same project and timeline.', he: 'פריים מרונדר מסוף השוט היוצא ומתחילת השוט הנכנס, מאותו פרויקט וטיימליין.' },
        action: { en: 'Generates a transition against a frozen boundary contract and rechecks it before placement.', he: 'מייצר מעבר מול חוזה גבולות קפוא, ומאמת אותו מחדש לפני ההצבה.' },
        output: { en: 'A reviewed transition clip placed on a managed track only if the original cut still matches.', he: 'קליפ Transition שנבדק ומוצב במסלול מנוהל רק אם החיתוך המקורי עדיין תואם.' },
        savings: { en: 'Removes two still exports, endpoint upload and manual alignment to the edit.', he: 'מבטל שני ייצואי Still, העלאת endpoints ויישור ידני לחיתוך.' },
        limitation: { en: 'Requires verified cloud video adapters and a current Resolve bridge.', he: 'דורש מתאמי וידאו בענן ו־Resolve bridge עדכני.' },
      },
    ],
  },
  {
    id: 'motion',
    index: '04',
    color: '#FFC16D',
    name: { en: 'Motion AI', he: 'מושן' },
    kicker: { en: 'ANIMATION · TITLES · CAPTIONS', he: 'אנימציה · טייטלים · כתוביות' },
    title: {
      en: 'Motion direction that starts with the assets already in the cut.',
      he: 'כיוון מושן שמתחיל בנכסים שכבר נמצאים בקאט.',
    },
    intro: {
      en: 'Bring images, video, audio, documents or public web context into a purpose-built animation recipe. Render locally when the runtime is packaged, keep the result in Library and decide when it joins the edit.',
      he: 'מביאים תמונות, וידאו, אודיו, מסמכים או הקשר מאתר ציבורי למתכון אנימציה ייעודי. מרנדרים מקומית כשה־runtime ארוז, שומרים בספרייה ומחליטים מתי התוצאה נכנסת לעריכה.',
    },
    sources: {
      en: ['Frames, clips and audio grabbed from the timeline', 'Images, video, audio and documents from Library/upload', 'Public URL context for supported animation recipes'],
      he: ['פריימים, קליפים ואודיו שנלכדו מהטיימליין', 'תמונות, וידאו, אודיו ומסמכים מהספרייה/Upload', 'הקשר מ־URL ציבורי למתכונים נתמכים'],
    },
    returns: {
      en: ['Rendered MP4 saved to Library', 'Download, Media Pool or timeline placement after review', 'Captions remain review-only in the current build'],
      he: ['MP4 מרונדר שנשמר בספרייה', 'הורדה, Media Pool או הצבה לאחר בדיקה', 'Captions נשארים Review בלבד בגרסה הנוכחית'],
    },
    savings: {
      en: ['No repeated asset collection in a separate motion app', 'Direction, render and import share one job record', 'Transcript handoff stays canonical instead of copy/paste'],
      he: ['אין איסוף מחדש של נכסים באפליקציית מושן נפרדת', 'הנחיה, render וייבוא נשארים באותה משימה', 'ה־Transcript עובר כמקור קנוני במקום copy/paste'],
    },
    pipeline: {
      source: { en: 'Edit assets', he: 'נכסי העריכה' },
      process: { en: 'Compose and render', he: 'קומפוזיציה ורינדור' },
      result: { en: 'Motion clip', he: 'קליפ מושן' },
    },
    tools: [
      {
        id: 'animations',
        name: { en: 'Animations', he: 'אנימציות' },
        summary: { en: 'Recipe-led motion graphics from the media and direction you provide.', he: 'Motion graphics מבוססי מתכון מהמדיה וההנחיה שסיפקתם.' },
        mode: 'local',
        availability: 'execution',
        input: { en: 'Prompt plus images, video, audio, documents or public URL context; timeline grabs are supported.', he: 'פרומפט עם תמונות, וידאו, אודיו, מסמכים או URL ציבורי; נתמך גם Grab מהטיימליין.' },
        action: { en: 'Builds custom, kinetic-text, product, overlay, visualizer and data/website-to-video compositions.', he: 'בונה קומפוזיציות Custom, טקסט קינטי, מוצר, overlay, visualizer ו־data/website-to-video.' },
        output: { en: 'MP4 with chosen aspect, FPS, duration and audio, saved to Library before placement.', he: 'MP4 ביחס, FPS, משך וסאונד שנבחרו, שנשמר בספרייה לפני הצבה.' },
        savings: { en: 'Connects source gathering, creative direction, render and import in one panel.', he: 'מחבר איסוף מקורות, creative direction, render וייבוא בפאנל אחד.' },
        limitation: { en: 'Established local path; public runtime packaging is still release-dependent.', he: 'נתיב מקומי קיים; אריזת ה־runtime הציבורית עדיין תלויה בהפצה.' },
      },
      {
        id: 'captions',
        name: { en: 'Captions', he: 'כתוביות' },
        summary: { en: 'Review a future native or styled caption workflow from one transcript.', he: 'בדיקת תהליך עתידי לכתוביות Native או Styled מתוך Transcript אחד.' },
        mode: 'review',
        availability: 'review',
        input: { en: 'Transcript handoff from Transcribe or transcript/audio/video from Upload, Library or timeline.', he: 'Handoff מ־Transcribe או Transcript/Audio/Video מ־Upload, מהספרייה או מהטיימליין.' },
        action: { en: 'Preserves the canonical transcript and exposes the intended caption recipe for review.', he: 'שומר את ה־Transcript הקנוני ומציג את מתכון הכתוביות המיועד לבדיקה.' },
        output: { en: 'Workflow review only; no subtitle track or Fusion titles are created yet.', he: 'Review של התהליך בלבד; עדיין לא נוצרים Subtitle Track או Fusion Titles.' },
        savings: { en: 'Avoids transcript copy/paste while keeping the future styling decision attached.', he: 'מבטל copy/paste של התמלול ושומר את החלטת העיצוב מחוברת למקור.' },
        limitation: { en: 'Review only — automatic caption application is not enabled.', he: 'Review בלבד — החלת כתוביות אוטומטית אינה פעילה.' },
      },
    ],
  },
  {
    id: 'audio',
    index: '05',
    color: '#45E1A5',
    name: { en: 'Audio AI', he: 'אודיו' },
    kicker: { en: 'SCORE · VOICE · TIMING', he: 'מוזיקה · קול · תזמון' },
    title: {
      en: 'From words and waveforms to audio you can place with intent.',
      he: 'ממילים ומגלי קול לאודיו שמוצב עם כוונה מדויקת.',
    },
    intro: {
      en: 'Create, spot, transcribe and analyze audio with explicit local/cloud boundaries. Every output is reviewed first; source-linked timing is preserved where the current integration supports it.',
      he: 'יוצרים, מתזמנים, מתמללים ומנתחים אודיו עם גבול ברור בין מקומי לענן. כל פלט נבדק קודם, ותזמון הקשור למקור נשמר במקום שבו האינטגרציה תומכת בכך.',
    },
    sources: {
      en: ['Exact trimmed audio or video from the timeline', 'Upload and local Library audio/video', 'Written direction, dialogue or sound-event prompts'],
      he: ['אודיו או וידאו לפי החיתוך המדויק בטיימליין', 'Audio/Video מ־Upload ומהספרייה המקומית', 'הנחיה כתובה, דיאלוג או prompts לאירועי סאונד'],
    },
    returns: {
      en: ['Generated audio and transcripts live in Library first', 'Approved takes use the global placement controls', 'Beat analysis imports marked media rather than changing the source clip'],
      he: ['אודיו ותמלולים נשמרים קודם בספרייה', 'Takes מאושרים משתמשים בבקרי ההצבה הגלובליים', 'Beat Detection מייבא מדיה מסומנת ואינו משנה את קליפ המקור'],
    },
    savings: {
      en: ['No external transcription upload and timecode rebuild', 'No manual cue log for reviewed Auto Foley events', 'No repetitive beat tapping or marker creation'],
      he: ['אין העלאה חיצונית לתמלול ובנייה מחדש של timecodes', 'אין cue logging ידני לאירועי Auto Foley שנבדקו', 'אין tapping חוזר או יצירה ידנית של עשרות markers'],
    },
    pipeline: {
      source: { en: 'Words or waveform', he: 'מילים או waveform' },
      process: { en: 'Create or analyze', he: 'יצירה או ניתוח' },
      result: { en: 'Timed audio asset', he: 'נכס אודיו מתוזמן' },
    },
    tools: [
      {
        id: 'create-music',
        name: { en: 'Create Music', he: 'יצירת מוזיקה' },
        summary: { en: 'Generate two complete track alternatives from a written brief.', he: 'יצירת שתי חלופות מלאות של טראק מתוך בריף כתוב.' },
        mode: 'cloud',
        availability: 'execution',
        input: { en: 'Text direction, style, title, lyrics/exclusions and vocal or instrumental controls.', he: 'הנחיה כתובה, סגנון, כותרת, lyrics/exclusions ובקרי vocal או instrumental.' },
        action: { en: 'Generates two full versions for listening and take selection.', he: 'מייצר שתי גרסאות מלאות להאזנה ולבחירת Take.' },
        output: { en: 'Both tracks enter Library; only selected takes are sent to Resolve.', he: 'שני הטראקים נכנסים לספרייה; רק Takes שנבחרו נשלחים ל־Resolve.' },
        savings: { en: 'Combines briefing, alternatives, listening, selection and import without an external music site.', he: 'מאחד בריף, חלופות, האזנה, בחירה וייבוא בלי אתר מוזיקה חיצוני.' },
        limitation: { en: 'Does not currently read selected-range duration or retime music to the cut.', he: 'אינו קורא כרגע את משך הטווח המסומן ואינו מתאים אוטומטית את הטראק לקאט.' },
      },
      {
        id: 'sound-effects',
        name: { en: 'Sound Effects', he: 'אפקטים קוליים' },
        summary: { en: 'Create one sound or review frame-ordered Auto Foley events.', he: 'יצירת סאונד יחיד או סקירת אירועי Auto Foley לפי סדר הפריימים.' },
        mode: 'hybrid',
        availability: 'adapter',
        input: { en: 'Single sound prompt, or an uploaded/exact timeline clip for Auto Foley spotting.', he: 'פרומפט לסאונד יחיד, או קליפ שהועלה/נלכד בדיוק מהטיימליין ל־Auto Foley.' },
        action: { en: 'Plans editable timed events; only approved sound prompts are sent to the sound provider.', he: 'מתכנן אירועים מתוזמנים וניתנים לעריכה; רק prompts מאושרים נשלחים לספק הסאונד.' },
        output: { en: 'Library results; source-linked Foley events can be placed at their captured offsets.', he: 'תוצאות בספרייה; אירועי Foley הקשורים למקור יכולים להיות מוצבים לפי ה־offset שנלכד.' },
        savings: { en: 'Combines watching, spotting, cue writing, generation and alignment in one review flow.', he: 'מאחד צפייה, spotting, כתיבת cue, יצירה ויישור לתהליך Review אחד.' },
        limitation: { en: 'Requires verified planner and sound-generation adapters.', he: 'דורש מתאמי planning ויצירת סאונד מאומתים.' },
      },
      {
        id: 'voice-over',
        name: { en: 'Voice Over', he: 'קריינות' },
        summary: { en: 'Audition voices and synthesize narration or multi-speaker dialogue.', he: 'Audition לקולות וסינתזה של קריינות או דיאלוג רב־דוברים.' },
        mode: 'cloud',
        availability: 'execution',
        input: { en: 'Manually entered text, voice/language choice, delivery controls, context and audio tags.', he: 'טקסט שמוזן ידנית, בחירת קול/שפה, בקרי delivery, הקשר ו־audio tags.' },
        action: { en: 'Builds one reviewed voice file with line-level direction and voice audition.', he: 'בונה קובץ קול אחד שניתן לבדיקה, עם הנחיות לפי שורה ו־audition.' },
        output: { en: 'An audio file in Library, ready for download or selected timeline placement.', he: 'קובץ אודיו בספרייה, מוכן להורדה או להצבה שנבחרה בטיימליין.' },
        savings: { en: 'Keeps audition, line editing, synthesis, review and import in one place.', he: 'שומר audition, עריכת שורות, synthesis, review וייבוא במקום אחד.' },
        limitation: { en: 'Does not currently read a timeline selection or transcript automatically.', he: 'אינו קורא כרגע טווח בטיימליין או Transcript באופן אוטומטי.' },
      },
      {
        id: 'transcribe',
        name: { en: 'Transcribe', he: 'תמלול' },
        summary: { en: 'Create an editable local transcript with word timing.', he: 'יצירת Transcript מקומי ועריך עם תזמון מילים.' },
        mode: 'local',
        availability: 'runtime',
        input: { en: 'Audio/video from Upload, Library or exact visible timeline trim, with optional vocabulary.', he: 'Audio/Video מ־Upload, מהספרייה או מהחיתוך הנראה בטיימליין, עם vocabulary אופציונלי.' },
        action: { en: 'Runs local Whisper transcription, language detection or supported English translation.', he: 'מריץ תמלול Whisper מקומי, זיהוי שפה או תרגום נתמך לאנגלית.' },
        output: { en: 'Timed editable transcript in Library with SRT, VTT, TXT and JSON export plus Captions handoff.', he: 'Transcript מתוזמן ועריך בספרייה, עם SRT, VTT, TXT, JSON ו־handoff ל־Captions.' },
        savings: { en: 'Removes media export to a cloud transcription service and manual timecode reconstruction.', he: 'מבטל ייצוא מדיה לשירות תמלול בענן ובנייה ידנית מחדש של timecodes.' },
        limitation: { en: 'Requires the packaged local Whisper runtime; it does not create a subtitle track.', he: 'דורש Whisper runtime מקומי ארוז; אינו יוצר Subtitle Track.' },
      },
      {
        id: 'beat-detection',
        name: { en: 'Beat Detection', he: 'זיהוי ביטים' },
        summary: { en: 'Analyze rhythm locally and review marker density before import.', he: 'ניתוח קצב מקומי ובדיקת צפיפות markers לפני ייבוא.' },
        mode: 'local',
        availability: 'runtime',
        input: { en: 'Audio from Upload, Library or the exact visible timeline trim.', he: 'אודיו מ־Upload, מהספרייה או מהחיתוך המדויק הנראה בטיימליין.' },
        action: { en: 'Calculates BPM, beats and confidence with density, spacing, offset and naming controls.', he: 'מחשב BPM, beats ו־confidence עם בקרי צפיפות, spacing, offset ושמות.' },
        output: { en: 'A sidecar beat map plus marked media imported to Media Pool or as a new timeline clip.', he: 'Beat map מסוג sidecar יחד עם מדיה מסומנת שמיובאת ל־Media Pool או כקליפ חדש.' },
        savings: { en: 'Replaces repetitive beat tapping and manual creation of dozens of markers.', he: 'מחליף tapping חוזר ויצירה ידנית של עשרות markers.' },
        limitation: { en: 'Requires the packaged librosa runtime; existing source clips are not modified.', he: 'דורש librosa runtime ארוז; קליפ המקור הקיים אינו משתנה.' },
      },
    ],
  },
]

