from pathlib import Path

from playwright.sync_api import sync_playwright

OUT_PATH = Path(__file__).resolve().parent / 'current_state.png'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.set_viewport_size({"width": 1400, "height": 1000})
    page.goto('http://localhost:8888/combined-playground.html')
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(1000)  # Let canvas render
    page.screenshot(path=str(OUT_PATH), full_page=True)
    print(f"Screenshot saved to {OUT_PATH}")
    browser.close()
