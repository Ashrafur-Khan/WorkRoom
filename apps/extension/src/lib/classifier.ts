// src/lib/classifier.ts
import type { Classification } from '../types';

// We'll hardcode these for now, but eventually, these should come from settings
const USER_BLOCKLIST: string[] = []; 
const USER_ALLOWLIST: string[] = [];

export function classifyUrl(url: string, title: string, goal: string): Classification {
  try {
    const domain = new URL(url).hostname;

    // 1. User's custom allow/block lists (highest priority)
    if (USER_BLOCKLIST.some(d => domain.includes(d))) return "off-task";
    if (USER_ALLOWLIST.some(d => domain.includes(d))) return "on-task";

    // 2. Universal distractions
    const DISTRACTIONS = [
      'instagram.com', 'facebook.com', 'twitter.com', 'tiktok.com',
      'reddit.com', 'netflix.com', 'twitch.tv', 'youtube.com/shorts'
    ];
    if (DISTRACTIONS.some(d => domain.includes(d))) return "off-task";

    // 3. Educational/productivity sites
    const PRODUCTIVE = [
      'github.com', 'stackoverflow.com', 'wikipedia.org',
      'arxiv.org', 'scholar.google.com', 'coursera.org',
      'notion.so', 'docs.google.com'
    ];
    if (PRODUCTIVE.some(d => domain.includes(d))) return "on-task";

    // 4. Keyword matching
    const goalKeywords = goal.toLowerCase().split(' ').filter(w => w.length > 3);
    const titleKeywords = title.toLowerCase();

    // Count how many meaningful goal words appear in the title
    const matches = goalKeywords.filter(word => 
      titleKeywords.includes(word)
    ).length;

    if (matches >= 1) return "on-task"; // Relaxed strictness slightly for demo
    
    return "ambiguous";
  } catch (e) {
    // Fallback for invalid URLs (like chrome:// extensions)
    return "ambiguous";
  }
}