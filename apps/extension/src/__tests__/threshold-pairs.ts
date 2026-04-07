/**
 * Labeled evaluation pairs for MiniLM-L6-v2 cosine similarity threshold calibration.
 *
 * Each pair represents a (goal, page) combination that Stage 1 classification sees:
 * only the page title and URL hostname tokens — no DOM signals.
 *
 * Labels:
 *   'on-task'   — the page is clearly relevant to the goal
 *   'off-task'  — the page is clearly irrelevant to the goal
 *   'borderline'— reasonable people would disagree
 */

export type ThresholdPair = {
  goal: string;
  pageTitle: string;
  pageUrl: string;
  expectedLabel: 'on-task' | 'off-task' | 'borderline';
  category: 'clear' | 'tricky' | 'borderline';
  note?: string;
};

export const THRESHOLD_PAIRS: ThresholdPair[] = [
  // ═══════════════════════════════════════════════════════════════
  // Goal 1: "study for biology exam"
  // ═══════════════════════════════════════════════════════════════

  // Clear on-task
  {
    goal: 'study for biology exam',
    pageTitle: 'Khan Academy | Cell Division and the Cell Cycle',
    pageUrl: 'https://www.khanacademy.org/science/biology/cellular-molecular-biology/mitosis/v/phases-of-mitosis',
    expectedLabel: 'on-task',
    category: 'clear',
  },
  {
    goal: 'study for biology exam',
    pageTitle: 'Mitosis and Meiosis — Biology LibreTexts',
    pageUrl: 'https://bio.libretexts.org/Bookshelves/Introductory_and_General_Biology/mitosis-meiosis',
    expectedLabel: 'on-task',
    category: 'clear',
  },

  // Clear off-task
  {
    goal: 'study for biology exam',
    pageTitle: 'ESPN — NBA Scores, Stats & Highlights',
    pageUrl: 'https://www.espn.com/nba/scoreboard',
    expectedLabel: 'off-task',
    category: 'clear',
  },
  {
    goal: 'study for biology exam',
    pageTitle: 'Funny Cat Videos Compilation 2026',
    pageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    expectedLabel: 'off-task',
    category: 'clear',
  },

  // Tricky on-task
  {
    goal: 'study for biology exam',
    pageTitle: 'Crash Course Biology #12 — DNA Structure and Replication',
    pageUrl: 'https://www.youtube.com/watch?v=8kK2zwjRV0M',
    expectedLabel: 'on-task',
    category: 'tricky',
    note: 'YouTube but educational biology content',
  },
  {
    goal: 'study for biology exam',
    pageTitle: 'Amoeba Sisters — Enzymes (Updated)',
    pageUrl: 'https://www.youtube.com/watch?v=qgVFkRn8f10',
    expectedLabel: 'on-task',
    category: 'tricky',
    note: 'YouTube edu channel, biology topic',
  },

  // Tricky off-task
  {
    goal: 'study for biology exam',
    pageTitle: 'Taylor Swift — Biography, Songs & Albums',
    pageUrl: 'https://en.wikipedia.org/wiki/Taylor_Swift',
    expectedLabel: 'off-task',
    category: 'tricky',
    note: '"bio" substring false positive',
  },
  {
    goal: 'study for biology exam',
    pageTitle: 'r/biology — help me pick a science tattoo design',
    pageUrl: 'https://www.reddit.com/r/biology/comments/abc123/help_me_pick_a_science_tattoo',
    expectedLabel: 'off-task',
    category: 'tricky',
    note: 'biology keyword but social/tangential content',
  },

  // Borderline
  {
    goal: 'study for biology exam',
    pageTitle: 'Quizlet — Chapter 5 Flashcards',
    pageUrl: 'https://quizlet.com/123456/chapter-5-flash-cards',
    expectedLabel: 'borderline',
    category: 'borderline',
    note: 'Study tool, but title gives no subject info',
  },

  // ═══════════════════════════════════════════════════════════════
  // Goal 2: "build a React todo app"
  // ═══════════════════════════════════════════════════════════════

  // Clear on-task
  {
    goal: 'build a React todo app',
    pageTitle: 'Tutorial: Tic-Tac-Toe — React',
    pageUrl: 'https://react.dev/learn/tutorial-tic-tac-toe',
    expectedLabel: 'on-task',
    category: 'clear',
  },
  {
    goal: 'build a React todo app',
    pageTitle: 'useState — React Reference',
    pageUrl: 'https://react.dev/reference/react/useState',
    expectedLabel: 'on-task',
    category: 'clear',
  },

  // Clear off-task
  {
    goal: 'build a React todo app',
    pageTitle: 'Amazon.com: Today\'s Deals — Electronics, Home, Fashion',
    pageUrl: 'https://www.amazon.com/deals',
    expectedLabel: 'off-task',
    category: 'clear',
  },
  {
    goal: 'build a React todo app',
    pageTitle: 'Wordle — A daily word game — The New York Times',
    pageUrl: 'https://www.nytimes.com/games/wordle/index.html',
    expectedLabel: 'off-task',
    category: 'clear',
  },

  // Tricky on-task
  {
    goal: 'build a React todo app',
    pageTitle: 'How to Use Zustand for State Management in React',
    pageUrl: 'https://blog.logrocket.com/zustand-react-state-management/',
    expectedLabel: 'on-task',
    category: 'tricky',
    note: 'State management library, relevant to building a React app',
  },
  {
    goal: 'build a React todo app',
    pageTitle: 'A Complete Guide to Flexbox — CSS-Tricks',
    pageUrl: 'https://css-tricks.com/snippets/css/a-guide-to-flexbox/',
    expectedLabel: 'on-task',
    category: 'tricky',
    note: 'CSS layout, needed for building any web app UI',
  },

  // Tricky off-task
  {
    goal: 'build a React todo app',
    pageTitle: 'Setting up the development environment — React Native',
    pageUrl: 'https://reactnative.dev/docs/environment-setup',
    expectedLabel: 'off-task',
    category: 'tricky',
    note: 'React keyword but mobile platform, not web todo app',
  },
  {
    goal: 'build a React todo app',
    pageTitle: 'Angular vs React vs Vue.js — Which Framework to Choose in 2026',
    pageUrl: 'https://www.techradar.com/best/javascript-frameworks-comparison',
    expectedLabel: 'off-task',
    category: 'tricky',
    note: 'Mentions React but comparison shopping, not building',
  },

  // Borderline
  {
    goal: 'build a React todo app',
    pageTitle: 'javascript — How to use Array.map() to render a list of items',
    pageUrl: 'https://stackoverflow.com/questions/123456/how-to-use-array-map-to-render-list',
    expectedLabel: 'borderline',
    category: 'borderline',
    note: 'Generic JS utility, loosely relevant to React list rendering',
  },

  // ═══════════════════════════════════════════════════════════════
  // Goal 3: "apply for software engineering jobs"
  // ═══════════════════════════════════════════════════════════════

  // Clear on-task
  {
    goal: 'apply for software engineering jobs',
    pageTitle: 'Software Engineer — Google Careers',
    pageUrl: 'https://careers.google.com/jobs/results/123456-software-engineer',
    expectedLabel: 'on-task',
    category: 'clear',
  },
  {
    goal: 'apply for software engineering jobs',
    pageTitle: 'Software Engineer Jobs — LinkedIn',
    pageUrl: 'https://www.linkedin.com/jobs/search/?keywords=software+engineer',
    expectedLabel: 'on-task',
    category: 'clear',
  },

  // Clear off-task
  {
    goal: 'apply for software engineering jobs',
    pageTitle: 'Instagram',
    pageUrl: 'https://www.instagram.com/',
    expectedLabel: 'off-task',
    category: 'clear',
  },
  {
    goal: 'apply for software engineering jobs',
    pageTitle: 'Steam Store — Featured & Recommended Games',
    pageUrl: 'https://store.steampowered.com/',
    expectedLabel: 'off-task',
    category: 'clear',
  },

  // Tricky on-task
  {
    goal: 'apply for software engineering jobs',
    pageTitle: 'Software Engineer Salaries at Google — Glassdoor',
    pageUrl: 'https://www.glassdoor.com/Salary/Google-Software-Engineer-Salaries-E9079.htm',
    expectedLabel: 'on-task',
    category: 'tricky',
    note: 'Salary research is part of job hunting',
  },
  {
    goal: 'apply for software engineering jobs',
    pageTitle: 'How to Write a Resume for Software Engineers — Indeed Career Guide',
    pageUrl: 'https://www.indeed.com/career-advice/resumes-cover-letters/software-engineer-resume',
    expectedLabel: 'on-task',
    category: 'tricky',
    note: 'Resume writing is directly part of applying',
  },

  // Tricky off-task
  {
    goal: 'apply for software engineering jobs',
    pageTitle: 'Two Sum — LeetCode',
    pageUrl: 'https://leetcode.com/problems/two-sum/',
    expectedLabel: 'off-task',
    category: 'tricky',
    note: 'Interview prep/practice, not actively applying',
  },

  // Borderline
  {
    goal: 'apply for software engineering jobs',
    pageTitle: 'ashrafur — GitHub',
    pageUrl: 'https://github.com/ashrafur',
    expectedLabel: 'borderline',
    category: 'borderline',
    note: 'Could be updating portfolio for applications, or just browsing',
  },
  {
    goal: 'apply for software engineering jobs',
    pageTitle: 'r/cscareerquestions — Advice on switching jobs mid-career',
    pageUrl: 'https://www.reddit.com/r/cscareerquestions/comments/xyz789/advice_switching_jobs',
    expectedLabel: 'borderline',
    category: 'borderline',
    note: 'Career advice community, mixed signal',
  },

  // ═══════════════════════════════════════════════════════════════
  // Goal 4: "write research paper on climate change"
  // ═══════════════════════════════════════════════════════════════

  // Clear on-task
  {
    goal: 'write research paper on climate change',
    pageTitle: 'NASA — Climate Change: Vital Signs of the Planet',
    pageUrl: 'https://climate.nasa.gov/vital-signs/',
    expectedLabel: 'on-task',
    category: 'clear',
  },
  {
    goal: 'write research paper on climate change',
    pageTitle: 'climate change impacts — Google Scholar',
    pageUrl: 'https://scholar.google.com/scholar?q=climate+change+impacts',
    expectedLabel: 'on-task',
    category: 'clear',
  },

  // Clear off-task
  {
    goal: 'write research paper on climate change',
    pageTitle: 'Netflix — Trending Now',
    pageUrl: 'https://www.netflix.com/browse',
    expectedLabel: 'off-task',
    category: 'clear',
  },
  {
    goal: 'write research paper on climate change',
    pageTitle: 'Home / X',
    pageUrl: 'https://x.com/home',
    expectedLabel: 'off-task',
    category: 'clear',
  },

  // Tricky on-task
  {
    goal: 'write research paper on climate change',
    pageTitle: 'Untitled document — Google Docs',
    pageUrl: 'https://docs.google.com/document/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ/edit',
    expectedLabel: 'on-task',
    category: 'tricky',
    note: 'Writing venue with vague title, but this is where the paper is being written',
  },

  // Tricky off-task
  {
    goal: 'write research paper on climate change',
    pageTitle: 'Climate change memes that hit different — r/funny',
    pageUrl: 'https://www.reddit.com/r/funny/comments/abc123/climate_change_memes',
    expectedLabel: 'off-task',
    category: 'tricky',
    note: 'Climate keyword but meme browsing',
  },

  // Borderline
  {
    goal: 'write research paper on climate change',
    pageTitle: 'Grammarly — Free AI Writing Assistance',
    pageUrl: 'https://app.grammarly.com/',
    expectedLabel: 'borderline',
    category: 'borderline',
    note: 'Writing tool, not research content, but supports the writing task',
  },
  {
    goal: 'write research paper on climate change',
    pageTitle: 'Zotero — Your personal research assistant',
    pageUrl: 'https://www.zotero.org/dashboard',
    expectedLabel: 'borderline',
    category: 'borderline',
    note: 'Citation management tool, supports research workflow',
  },

  // ═══════════════════════════════════════════════════════════════
  // Goal 5: "learn Spanish on Duolingo"
  // ═══════════════════════════════════════════════════════════════

  // Clear on-task
  {
    goal: 'learn Spanish on Duolingo',
    pageTitle: 'Duolingo — Learn Spanish for Free',
    pageUrl: 'https://www.duolingo.com/learn',
    expectedLabel: 'on-task',
    category: 'clear',
  },
  {
    goal: 'learn Spanish on Duolingo',
    pageTitle: 'SpanishDict | English to Spanish Translation, Dictionary, Conjugation',
    pageUrl: 'https://www.spanishdict.com/translate/hello',
    expectedLabel: 'on-task',
    category: 'clear',
  },

  // Clear off-task
  {
    goal: 'learn Spanish on Duolingo',
    pageTitle: 'TikTok — Make Your Day',
    pageUrl: 'https://www.tiktok.com/foryou',
    expectedLabel: 'off-task',
    category: 'clear',
  },
  {
    goal: 'learn Spanish on Duolingo',
    pageTitle: 'Twitch — Live Gaming & Esports Streams',
    pageUrl: 'https://www.twitch.tv/',
    expectedLabel: 'off-task',
    category: 'clear',
  },

  // Tricky on-task
  {
    goal: 'learn Spanish on Duolingo',
    pageTitle: 'Beginner Spanish Listening Practice — Real Conversations',
    pageUrl: 'https://www.youtube.com/watch?v=span456',
    expectedLabel: 'on-task',
    category: 'tricky',
    note: 'YouTube but Spanish listening practice',
  },
  {
    goal: 'learn Spanish on Duolingo',
    pageTitle: 'Conjugation of "ser" — 123TeachMe',
    pageUrl: 'https://www.123teachme.com/spanish_verb_conjugation/ser',
    expectedLabel: 'on-task',
    category: 'tricky',
    note: 'Grammar reference, different site from Duolingo but on-topic',
  },

  // Tricky off-task
  {
    goal: 'learn Spanish on Duolingo',
    pageTitle: 'Google Translate',
    pageUrl: 'https://translate.google.com/?sl=en&tl=es',
    expectedLabel: 'off-task',
    category: 'tricky',
    note: 'Translation tool, not a learning activity',
  },

  // Borderline
  {
    goal: 'learn Spanish on Duolingo',
    pageTitle: 'Tips for learning a second language — r/languagelearning',
    pageUrl: 'https://www.reddit.com/r/languagelearning/comments/xyz/tips_second_language',
    expectedLabel: 'borderline',
    category: 'borderline',
    note: 'Relevant topic on social media platform',
  },
];
