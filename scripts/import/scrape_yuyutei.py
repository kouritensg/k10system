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
    Locate card blocks on a Yuyu-tei sell page.

    As of 2026-06, each card is a <div class="card-product ..."> element.
    Falls back to structural detection if that class is ever renamed.
    """
    # Primary selector — confirmed on BT25 sell page
    blocks = soup.select("div.card-product")
    if len(blocks) > 0:
        return blocks

    # Fallback: any div that contains both a card-image and a yen price
    price_re = re.compile(r'\d[\d,]* 円')
    blocks = [
        d for d in soup.find_all("div")
        if d.find("img") and price_re.search(d.get_text()) and len(d.get_text()) < 800
    ]
    return blocks


def parse_card_block(block, base_url: str) -> dict | None:
    """
    Parse one card-product div into a card dict.

    Page structure (confirmed 2026-06):
      <div class="card-product ...">
        <a href="/sell/digi/card/bt25/10128">
          <img src="https://card.yuyu-tei.jp/digi/100_140/bt25/10128.jpg"
               alt="BT25-103 P-SEC グレイスノヴァモン(パラレル)" class="card img-fluid"/>
        </a>
        <span class="d-block border border-dark ...">BT25-103</span>
        <a href="..."><h4 class="text-primary fw-bold">グレイスノヴァモン(パラレル)</h4></a>
        <strong class="d-block text-end">2,980 円</strong>
        ...
      </div>

    Rarity is NOT a separate element — it lives in the <img alt> as the second
    space-separated token after the card ID, e.g. "BT25-103 P-SEC グレイスノヴァモン".
    """

    # --- image + alt-text (card_id, rarity, name all derivable from here) ---
    img = block.find("img", class_="card")
    if not img:
        img = block.find("img")

    alt = img.get("alt", "") if img else ""
    image_url = make_absolute(img.get("src", ""), base_url) if img else None

    # --- card_id: explicit <span class="... border-dark ..."> first, then alt ---
    card_id = None
    id_span = block.find("span", class_=lambda c: c and "border-dark" in c)
    if id_span:
        card_id = id_span.get_text(strip=True) or None
    if not card_id:
        card_id = extract_card_id(alt)

    # --- name: <h4> inside the block ---
    h4 = block.find("h4")
    name = h4.get_text(strip=True) if h4 else None
    if not name and alt:
        # Strip card_id and rarity token from alt to get name
        parts = alt.strip().split(" ", 2)
        name = parts[2] if len(parts) >= 3 else alt
    if not name:
        return None

    # --- rarity: second space-separated token in alt after card_id ---
    rarity = None
    if alt and card_id:
        # alt format: "{card_id} {rarity} {name}" — rarity is the token between id and name
        after_id = alt.replace(card_id, "", 1).strip()
        rarity_token = after_id.split(" ")[0] if after_id else ""
        # Only treat it as rarity if it looks like one (short, uppercase, no Japanese chars)
        if rarity_token and len(rarity_token) <= 8 and re.match(r'^[A-Za-z0-9\-]+$', rarity_token):
            rarity = rarity_token.upper()

    # --- price: <strong class="d-block text-end"> ---
    strong = block.find("strong")
    reference_price = extract_price(strong.get_text() if strong else "")

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
