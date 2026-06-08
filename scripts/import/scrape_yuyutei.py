#!/usr/bin/env python3
"""
scrape_yuyutei.py — scrape a Yuyu-tei sell page and output a K10 import JSON.

Usage:
    python3 scrape_yuyutei.py <url> [--out FILE] [--source yuyu-tei] [--game-hint digimon]

The output JSON matches the shape expected by POST /api/inventory/singles/import.
"""

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

USER_AGENT = "K10System-scraper/1.0"

RARITY_NORMALISE = {
    "common": "C", "c": "C",
    "uncommon": "U", "u": "U",
    "rare": "R", "r": "R",
    "super rare": "SR", "superrare": "SR", "sr": "SR",
    "ultra rare": "UR", "ultrarare": "UR", "ur": "UR",
    "secret rare": "SEC", "secretrare": "SEC", "sec": "SEC",
    "leader rare": "L", "leader": "L", "l": "L",
    "promo": "P", "p": "P",
    "alternative art": "AA", "alt art": "AA", "aa": "AA",
    "double rare": "RR", "rr": "RR",
    "triple rare": "RRR", "rrr": "RRR",
}

CARD_ID_PATTERN = re.compile(r'\b([A-Z]{1,4}[-_]?\d{2,4}[A-Z]?\d*)\b')
PRICE_DIGITS = re.compile(r'[\d,]+')


def normalise_rarity(raw: str) -> str | None:
    if not raw:
        return None
    clean = raw.strip().lower()
    return RARITY_NORMALISE.get(clean, raw.strip().upper()[:10] or None)


def extract_card_id(text: str) -> str | None:
    m = CARD_ID_PATTERN.search(text)
    return m.group(1) if m else None


def extract_price(text: str) -> int:
    digits = PRICE_DIGITS.findall(text.replace(",", ""))
    if digits:
        try:
            return int(digits[0].replace(",", ""))
        except ValueError:
            pass
    return 0


def make_absolute(url: str, base: str) -> str:
    if not url:
        return ""
    if url.startswith("http"):
        return url
    parsed = urlparse(base)
    return f"{parsed.scheme}://{parsed.netloc}{url if url.startswith('/') else '/' + url}"


def fetch_page(url: str, max_retries: int = 5) -> BeautifulSoup:
    headers = {"User-Agent": USER_AGENT, "Accept-Language": "ja,en;q=0.9"}
    delay = 5  # initial retry delay in seconds
    for attempt in range(max_retries):
        resp = requests.get(url, headers=headers, timeout=20)
        if resp.status_code == 429:
            retry_after = int(resp.headers.get("Retry-After", delay))
            wait = max(retry_after, delay)
            print(f"Rate limited (429). Waiting {wait}s before retry {attempt + 1}/{max_retries}…", file=sys.stderr)
            time.sleep(wait)
            delay = min(delay * 2, 120)  # exponential backoff, cap at 2 min
            continue
        resp.raise_for_status()
        return BeautifulSoup(resp.text, "html.parser")
    raise RuntimeError(f"Exceeded {max_retries} retries due to rate limiting on {url}")


def find_card_blocks(soup: BeautifulSoup):
    """
    Find repeating card blocks using a structure-based approach.

    Yuyu-tei sell pages list cards in <li> or <div> elements that each contain:
      - an image (<img>)
      - a name/title element
      - a price element

    Strategy: find the element type+class that appears most often AND contains
    both an img and a price-like string, then treat those as card blocks.
    """
    candidates = []

    # Try common container selectors used on Yuyu-tei sell pages
    for selector in [
        "ul.card-list > li",
        "ul.sell-list > li",
        ".card_list > li",
        ".product-list > li",
        ".item-list > li",
        "li.card-item",
        "li[class*='card']",
        "div[class*='card-item']",
        "div[class*='product-item']",
    ]:
        blocks = soup.select(selector)
        if len(blocks) > 5:
            candidates.append((len(blocks), blocks))

    if candidates:
        candidates.sort(key=lambda x: -x[0])
        return candidates[0][1]

    # Fallback: find all <li> that contain both an <img> and a price pattern
    price_re = re.compile(r'¥[\d,]+|\d{2,}円')
    li_blocks = [
        li for li in soup.find_all("li")
        if li.find("img") and price_re.search(li.get_text())
    ]
    if len(li_blocks) > 3:
        return li_blocks

    # Last resort: any div containing img + price text
    div_blocks = [
        d for d in soup.find_all("div")
        if d.find("img") and price_re.search(d.get_text()) and len(d.get_text()) < 500
    ]
    return div_blocks


def parse_card_block(block, base_url: str) -> dict | None:
    text = block.get_text(separator=" ", strip=True)

    # --- card_id ---
    card_id = extract_card_id(text)

    # --- name ---
    # Prefer an explicit name element; fall back to longest non-price, non-id text span
    name_el = (
        block.find(class_=re.compile(r'name|title|card.?name', re.I))
        or block.find("h3") or block.find("h4") or block.find("p")
    )
    name = name_el.get_text(strip=True) if name_el else ""
    if not name:
        # Derive from full text, remove price tokens
        name = re.sub(r'¥[\d,]+|[\d,]+円|\bNM\b|\bLP\b|\bMP\b', '', text).strip()[:80]
    name = name.strip()
    if not name:
        return None

    # --- rarity ---
    rarity_el = block.find(class_=re.compile(r'rarity|rare', re.I))
    rarity_raw = rarity_el.get_text(strip=True) if rarity_el else None
    if not rarity_raw:
        # Try badge/small text
        for tag in block.find_all(["span", "small", "em"]):
            t = tag.get_text(strip=True)
            if t and len(t) <= 10:
                rarity_raw = t
                break
    rarity = normalise_rarity(rarity_raw)

    # --- price ---
    price_el = block.find(class_=re.compile(r'price|cost|yen', re.I))
    price_text = price_el.get_text(strip=True) if price_el else text
    reference_price = extract_price(price_text)

    # --- image ---
    img = block.find("img")
    image_url = ""
    if img:
        src = img.get("data-src") or img.get("src") or ""
        image_url = make_absolute(src, base_url)

    return {
        "card_id": card_id,
        "name": name,
        "rarity": rarity,
        "reference_price": reference_price,
        "currency": "JPY",
        "image_url": image_url or None,
    }


def derive_set_code(url: str) -> str:
    parts = urlparse(url).path.rstrip("/").split("/")
    return parts[-1] if parts else "output"


def scrape(url: str, source: str, game_hint: str | None) -> list[dict]:
    soup = fetch_page(url)
    blocks = find_card_blocks(soup)

    # Handle pagination: look for a "next" link
    all_blocks = list(blocks)
    visited = {url}
    page = 1

    while True:
        next_link = soup.find("a", string=re.compile(r'次|next|›|»', re.I))
        if not next_link:
            break
        next_url = make_absolute(next_link.get("href", ""), url)
        if not next_url or next_url in visited:
            break
        visited.add(next_url)
        page += 1
        time.sleep(1)
        soup = fetch_page(next_url)
        all_blocks.extend(find_card_blocks(soup))

    cards = []
    seen_ids: set[str] = set()
    for block in all_blocks:
        parsed = parse_card_block(block, url)
        if not parsed:
            continue
        # Deduplicate by card_id if present
        key = parsed["card_id"] or parsed["name"]
        if key in seen_ids:
            continue
        seen_ids.add(key)
        cards.append(parsed)

    return cards


def main():
    parser = argparse.ArgumentParser(description="Scrape Yuyu-tei sell page → K10 import JSON")
    parser.add_argument("url", help="Yuyu-tei sell page URL, e.g. https://yuyu-tei.jp/sell/digi/s/bt25")
    parser.add_argument("--out", default=None, help="Output JSON file path (default: <set-code>.json)")
    parser.add_argument("--source", default="yuyu-tei", help="Source name embedded in JSON")
    parser.add_argument("--game-hint", default=None, help="Game name hint (e.g. digimon) included in output")
    args = parser.parse_args()

    out_file = args.out or (derive_set_code(args.url) + ".json")

    print(f"Fetching {args.url} …")
    cards = scrape(args.url, args.source, args.game_hint)

    if not cards:
        print("WARNING: no cards found — the page structure may have changed. Inspect the HTML manually.", file=sys.stderr)
        sys.exit(1)

    output = {
        "source": args.source,
        "source_url": args.url,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "game_hint": args.game_hint,
        "cards": cards,
    }

    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"Scraped {len(cards)} cards from {args.url} → wrote {out_file}")


if __name__ == "__main__":
    main()
