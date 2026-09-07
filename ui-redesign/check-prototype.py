from pathlib import Path
import json, os, shutil
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).parent
html=(ROOT/'uimori-ui-prototype.html').read_text()
report={'scope':'standalone synthetic HTML prototype only; not Uimori application E2E','checks':[],'screenshots':[]}
with sync_playwright() as p:
    binary=os.environ.get('BROWSER_EXECUTABLE') or shutil.which('chromium')
    browser=p.chromium.launch(headless=True,**({'executable_path':binary} if binary else {}))
    page=browser.new_page(viewport={'width':1440,'height':1000},device_scale_factor=1)
    errors=[];page.on('pageerror',lambda e: errors.append(str(e)))
    page.set_content(html);page.wait_for_timeout(350)
    page.screenshot(path=str(ROOT/'desktop-chat.png'));report['screenshots'].append('desktop-chat.png')
    assert page.locator('#briefInput').is_visible()
    assert page.locator('#briefInput').bounding_box()['y']<1000
    report['checks'].append('desktop composer visible without scrolling')
    page.get_by_role('button',name='원문',exact=True).click()
    assert page.locator('.prose').first.inner_text().startswith('After the Rain')
    page.get_by_role('button',name='번역',exact=True).click()
    report['checks'].append('original/translation toggle')
    page.get_by_role('button',name='이야기 설정 열기').click()
    page.screenshot(path=str(ROOT/'desktop-context.png'));report['screenshots'].append('desktop-context.png')
    page.keyboard.press('Escape');assert not page.locator('#panel').is_visible()
    page.get_by_role('button',name='다른 전개 보기',exact=True).click()
    page.get_by_role('button',name='이 전개 읽기',exact=True).click()
    assert '내일의 날짜' in page.locator('.prose').first.inner_text()
    report['checks'].append('sibling candidate navigation without generation')
    page.get_by_role('button',name='서재',exact=True).click()
    page.screenshot(path=str(ROOT/'desktop-library.png'));report['screenshots'].append('desktop-library.png')
    page.get_by_label('서재 검색').fill('은빛');assert page.locator('.content-card').count()==1
    page.get_by_label('서재 검색').fill('');report['checks'].append('library search and cards')
    page.get_by_role('button',name='설정',exact=True).click()
    page.get_by_label('테마',exact=True).select_option('light');assert page.locator('html').get_attribute('data-theme')=='light'
    page.locator('[data-chat="rain"]').first.click()
    page.screenshot(path=str(ROOT/'desktop-light.png'));report['screenshots'].append('desktop-light.png')
    page.locator('#briefInput').fill('모의 응답 테스트')
    page.keyboard.press('Control+Enter')
    assert page.locator('#running').is_visible()
    page.wait_for_timeout(3000)
    assert '모의 후속 장면' in page.locator('#timeline').inner_text()
    assert not page.locator('#running').is_visible()
    report['checks'].append('mock send, task state, result; no provider calls')

    page.locator('#briefInput').fill('보존할 미전송 초안')
    page.locator('[data-chat="train"]').first.click()
    assert page.locator('#briefInput').input_value()==''
    page.locator('[data-chat="rain"]').first.click()
    assert page.locator('#briefInput').input_value()=='보존할 미전송 초안'
    report['checks'].append('synthetic draft isolated across conversation switches')
    page.locator('#briefInput').fill('')
    # Default mobile view, no actual mobile OS claim.
    mobile=browser.new_page(viewport={'width':390,'height':844},device_scale_factor=1,is_mobile=True,has_touch=True)
    mobile.on('pageerror',lambda e: errors.append(str(e)))
    mobile.set_content(html);mobile.wait_for_timeout(150)
    mobile.screenshot(path=str(ROOT/'mobile-chat.png'));report['screenshots'].append('mobile-chat.png')
    mobile.get_by_role('button',name='탐색 메뉴 열기').click()
    assert mobile.locator('#panel').is_visible()
    mobile.get_by_role('button',name='서재',exact=True).last.click()
    assert mobile.locator('#libraryScreen').is_visible()
    mobile.screenshot(path=str(ROOT/'mobile-library.png'));report['screenshots'].append('mobile-library.png')
    mobile.get_by_role('button',name='탐색 메뉴 열기').click()
    mobile.locator('#panel [data-chat="rain"]').click()
    mobile.get_by_role('button',name='이야기 설정 열기').click()
    mobile.screenshot(path=str(ROOT/'mobile-context.png'));report['screenshots'].append('mobile-context.png')
    mobile.keyboard.press('Escape')
    report['checks'].append('mobile drawer navigation and settings sheet')
    mobile.get_by_role('button',name='집중해서 읽기').click()
    assert not mobile.locator('.composer-wrap').is_visible()
    mobile.get_by_role('button',name='대화 화면으로 돌아가기').click()
    assert mobile.locator('.composer-wrap').is_visible()
    report['checks'].append('reading focus mode enter/exit')
    for w,h in [(360,800),(390,844),(768,1024),(1024,768),(1440,1000)]:
        page=browser.new_page(viewport={'width':w,'height':h});page.on('pageerror',lambda e: errors.append(str(e)));page.set_content(html)
        width=page.evaluate('({scroll:document.documentElement.scrollWidth,viewport:innerWidth})')
        assert width['scroll']<=width['viewport'],width
        bounds=page.locator('#briefInput').bounding_box()
        assert bounds and bounds['y']+bounds['height']<=h
        report['checks'].append(f'layout {w}x{h}: no page horizontal overflow; composer visible');page.close()
    report['pageErrors']=errors
    assert not errors,errors
    report['status']='PASS';report['browser']=browser.version;report['environment']='Linux Chromium, emulated viewport; not Windows or actual Android device'
    browser.close()
(ROOT/'prototype-checks.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
