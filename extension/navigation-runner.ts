import {
  CONTENTS_CHARACTER_LIMIT,
  CONTENTS_LINK_LIMIT,
  type ContentsCapture,
  type NovelInspection,
} from '../src/lib/extension/contracts'
import { discoverContents, preferChapterTitle } from '../src/lib/extension/contents'
import {
  MAX_TOTAL_CAPTURE_CHARACTERS,
  publicPageUrl,
  type CapturedPage,
} from '../src/lib/scraper/contracts'
import {
  checkNavigationDecision,
  NAVIGATION_LIMITS,
  type NavigationDecision,
  type NavigationGoal,
  type NavigationPlanResult,
  type NavigationRun,
  type NavigationSnapshot,
  type NavigationRecipe,
  navigationRecipeLabel,
} from '../src/lib/extension/navigation'

export interface NavigationDriver {
  observe: () => Promise<NavigationSnapshot>
  collect: (snapshot: NavigationSnapshot) => Promise<ContentsCapture>
  act: (snapshot: NavigationSnapshot, decision: NavigationDecision) => Promise<void>
  changed: (previous: NavigationSnapshot) => Promise<NavigationSnapshot>
  capture: () => Promise<CapturedPage>
  decide: (
    snapshot: NavigationSnapshot,
    history: NavigationRun['activity'],
  ) => Promise<NavigationPlanResult>
  stopped: () => Promise<boolean>
  progress: (run: NavigationRun, inventory?: ContentsCapture) => Promise<void>
}

export async function scanChapterContents(
  origin: string,
  inspection: Pick<NovelInspection, 'chapterLinks' | 'chapterCount' | 'indexUrl'>,
  driver: Pick<NavigationDriver, 'observe' | 'collect' | 'act' | 'changed' | 'stopped'>,
  progress: (capture: ContentsCapture, actions: number) => Promise<void>,
  savedRecipes: NavigationRecipe[] = [],
): Promise<{
  capture: ContentsCapture
  actions: number
  reason: string
  recipes: NavigationRecipe[]
  reused: number
  invalidated: boolean
}> {
  const recipes: NavigationRecipe[] = []
  const failedRecipes = new Set<string>()
  let reused = 0
  let invalidated = false
  const links = new Map<string, ContentsCapture['links'][number]>()
  const visited = new Set<string>()
  const visitedUrls = new Set<string>()
  const ordered = new Set<string>()
  const started = Date.now()
  let characters = 0
  let actions = 0
  let snapshot = await driver.observe()
  let capture: ContentsCapture = {
    url: snapshot.url,
    title: snapshot.title,
    links: [],
    truncated: false,
  }
  let reason = 'No more contents controls found.'
  const ascending = /ascending|oldest\s*first|\u6b63\u5e8f|\u5347\u5e8f/i
  const contentsLabel =
    /^(?:(?:click\s+)?(?:to\s+)?(?:view|open|show|read)\s+)?(?:all\s+chapters?(?:\s+(?:list|catalog|directory))?|(?:(?:full|complete)\s+)?(?:table\s+of\s+)?contents|(?:full|complete)\s+(?:catalog(?:ue)?|directory|chapter\s+list)|chapter\s+(?:list|catalog(?:ue)?|directory)|(?:\u67e5\u770b|\u95b1\u8b80|\u9605\u8bfb)?(?:\u5168\u90e8|\u5b8c\u6574)?(?:\u7ae0\u7bc0|\u7ae0\u8282)?(?:\u76ee\u9304|\u76ee\u5f55))\s*[>\u00bb\u203a]?$/i
  const expand =
    /expand\s+(?:all|.*chapters?)|show\s+all|(?:load|view|show)\s+more(?:\s+chapters?)?|\u5c55[\u5f00\u958b]|\u67e5\u770b\u66f4\u591a|\u52a0[\u8f7d\u8f09]\u66f4\u591a/i
  for (;;) {
    if (await driver.stopped()) {
      capture.truncated = true
      reason = 'Scan stopped.'
      break
    }
    if (new URL(snapshot.url).origin !== origin)
      throw new Error('The contents page left the selected site.')
    if (snapshot.blocked)
      throw new Error('This page needs manual access review. No further navigation was performed.')
    if (visited.has(snapshot.fingerprint)) {
      capture.truncated = true
      reason = 'Repeated contents page; scan stopped.'
      break
    }
    visited.add(snapshot.fingerprint)
    const current = await driver.collect(snapshot)
    visitedUrls.add(snapshot.url)
    capture.truncated ||= current.truncated
    for (const link of current.links) {
      const existing = links.get(link.url)
      if (existing) {
        if (preferChapterTitle(link.title, existing.title)) {
          const updatedCharacters = characters + link.title.length - existing.title.length
          if (updatedCharacters <= CONTENTS_CHARACTER_LIMIT) {
            characters = updatedCharacters
            links.set(link.url, link)
          } else capture.truncated = true
        }
        continue
      }
      if (
        links.size >= CONTENTS_LINK_LIMIT ||
        characters + link.url.length + link.title.length > CONTENTS_CHARACTER_LIMIT
      ) {
        capture.truncated = true
        break
      }
      links.set(link.url, link)
      characters += link.url.length + link.title.length
    }
    capture.links = [...links.values()]
    await progress({ ...capture }, actions)
    if (capture.truncated) {
      reason = 'The contents capture limit was reached.'
      break
    }
    const discovered = discoverContents(capture, inspection)
    const availableControls = snapshot.controls.filter(
      (control) =>
        !failedRecipes.has(navigationRecipeLabel(control.label)) &&
        !/\b(?:comments?|reviews?)\b/i.test(control.label),
    )
    const contentsControl = availableControls.find(
      (entry) =>
        entry.url &&
        entry.url !== snapshot.url &&
        !visitedUrls.has(entry.url) &&
        contentsLabel.test(entry.label.trim()),
    )
    const reachedReportedCount =
      inspection.chapterCount !== null && discovered.foundCount >= inspection.chapterCount
    const reusable = savedRecipes
      .map((recipe) => ({
        recipe,
        control: availableControls.find((control) => {
          const repeatable =
            ['load_more', 'next_page'].includes(recipe.intent) && !reachedReportedCount
          return (
            control.role === recipe.role &&
            navigationRecipeLabel(control.label) === recipe.label &&
            (recipe.intent !== 'contents' ||
              (control.url && control.url !== snapshot.url && !visitedUrls.has(control.url))) &&
            (!control.url || new URL(control.url).origin === origin) &&
            (control.role !== 'select' ||
              control.options.some((option) => option.value === recipe.value)) &&
            (!ordered.has(`${snapshot.url}:${control.label}`) || repeatable)
          )
        }),
      }))
      .find((entry) => entry.control && !failedRecipes.has(entry.recipe.label))
    const control =
      reusable?.control ??
      contentsControl ??
      availableControls.find(
        (entry) =>
          entry.role !== 'select' &&
          expand.test(entry.label) &&
          !(reachedReportedCount && ordered.has(`${snapshot.url}:${entry.label}`)),
      ) ??
      availableControls.find(
        (entry) =>
          !ordered.has(`${snapshot.url}:${entry.label}`) &&
          (entry.role === 'select'
            ? entry.options.some((option) => ascending.test(option.label))
            : ascending.test(entry.label)),
      ) ??
      availableControls.find(
        (entry) =>
          snapshot.chapterLinkCount > 0 &&
          entry.role !== 'select' &&
          (entry.url
            ? discoverContents(current, inspection).nextContentsUrls.includes(entry.url) &&
              !/next\s+chapter/i.test(entry.label)
            : /^(?:next(?:\s+page)?|\u4e0b\u4e00\u9875|\u4e0b\u4e00\u9801|\u4e0b\u9875|\u4e0b\u9801)\s*[>\u00bb\u203a]?$/i.test(
                entry.label.trim(),
              )),
      )
    if (!control) {
      if (inspection.chapterCount !== null && discovered.foundCount < inspection.chapterCount) {
        capture.truncated = true
        reason = `Found ${discovered.foundCount} of ${inspection.chapterCount} reported links; no further contents control was found.`
      }
      break
    }
    if (actions >= 40 || Date.now() - started >= NAVIGATION_LIMITS.durationMs) {
      capture.truncated = true
      reason = 'The scan limit was reached; more contents may remain.'
      break
    }
    const value =
      reusable?.control === control
        ? reusable.recipe.value
        : control.role === 'select'
          ? (control.options.find((option) => ascending.test(option.label))?.value ?? null)
          : null
    const decision: NavigationDecision = {
      action: control.role === 'select' ? 'select' : 'click',
      controlId: control.id,
      value,
      intent:
        reusable?.control === control
          ? reusable.recipe.intent
          : control === contentsControl
            ? 'contents'
            : expand.test(control.label)
              ? 'load_more'
              : ascending.test(control.label) || control.role === 'select'
                ? 'ascending'
                : 'next_page',
      pageType: 'contents',
      repeat: false,
      reason: 'Reveal the chapter list.',
    }
    checkNavigationDecision(snapshot, decision)
    if (await driver.stopped()) {
      capture.truncated = true
      reason = 'Scan stopped.'
      break
    }
    ordered.add(`${snapshot.url}:${control.label}`)
    await driver.act(snapshot, decision)
    actions++
    const next = await driver.changed(snapshot)
    if (next.fingerprint === snapshot.fingerprint) {
      if (reusable?.control === control) {
        failedRecipes.add(reusable.recipe.label)
        invalidated = true
        visited.delete(snapshot.fingerprint)
        snapshot = next
        continue
      }
      capture.truncated = true
      reason = 'A contents control did not reveal more content.'
      break
    }
    if (reusable?.control === control) reused++
    const recipe: NavigationRecipe = {
      label: navigationRecipeLabel(control.label),
      role: control.role,
      value,
      intent: decision.intent as NavigationRecipe['intent'],
    }
    if (
      !recipes.some(
        (entry) =>
          entry.label === recipe.label &&
          entry.role === recipe.role &&
          entry.value === recipe.value,
      )
    )
      recipes.push(recipe)
    snapshot = next
    if (decision.intent === 'contents')
      capture = { ...capture, url: snapshot.url, title: snapshot.title }
  }
  const nextUrls = new Set(discoverContents(capture, inspection).nextContentsUrls)
  capture.links = capture.links.filter(
    (link) => !nextUrls.has(link.url) || !visitedUrls.has(link.url),
  )
  return { capture, actions, reason, recipes, reused, invalidated }
}

export async function exploreBrowser(
  id: string,
  goal: NavigationGoal,
  origin: string,
  driver: NavigationDriver,
): Promise<NavigationRun> {
  const started = Date.now()
  const run: NavigationRun = {
    id,
    goal,
    state: 'running',
    stage: 'Observing the page',
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    actions: 0,
    pages: [],
    activity: [],
  }
  const links = new Map<string, ContentsCapture['links'][number]>()
  const visited = new Set<string>()
  let inventory: ContentsCapture | undefined
  let inventoryCharacters = 0
  let recipe:
    { decision: NavigationDecision; label: string; role: string; value: string | null } | undefined
  let next: NavigationSnapshot | undefined
  let bestContentsCount = 0

  const stopped = async () => {
    if (await driver.stopped()) {
      run.state = 'stopped'
      run.reason = 'Stopped by you. Completed captures are kept.'
      return true
    }
    if (Date.now() - started >= NAVIGATION_LIMITS.durationMs) {
      run.state = 'stopped'
      run.reason = 'The navigation time budget was reached.'
      return true
    }
    return false
  }
  const publish = () =>
    driver.progress({ ...run, activity: [...run.activity], pages: [...run.pages] }, inventory)
  try {
    for (;;) {
      if (await stopped()) break
      const snapshot = next ?? (await driver.observe())
      next = undefined
      if (new URL(snapshot.url).origin !== origin)
        throw new Error('The tab left the approved site. Navigation stopped.')
      if (snapshot.blocked) {
        run.state = 'stopped'
        run.reason = 'This page needs manual access review. No further action was taken.'
        break
      }
      if (visited.has(snapshot.fingerprint)) {
        run.state = 'stopped'
        run.reason = 'This page state was already visited. Stopped to avoid a navigation loop.'
        break
      }
      visited.add(snapshot.fingerprint)
      const captured = await driver.collect(snapshot)
      let truncated = inventory?.truncated || captured.truncated
      for (const link of captured.links) {
        if (links.has(link.url)) continue
        if (
          links.size >= CONTENTS_LINK_LIMIT ||
          inventoryCharacters + link.url.length + link.title.length > CONTENTS_CHARACTER_LIMIT
        ) {
          truncated = true
          break
        }
        links.set(link.url, link)
        inventoryCharacters += link.url.length + link.title.length
      }
      if (!inventory || snapshot.chapterLinkCount >= bestContentsCount) {
        inventory = { ...captured }
        bestContentsCount = snapshot.chapterLinkCount
      }
      inventory = { ...inventory, links: [...links.values()], truncated: Boolean(truncated) }
      run.stage = `Observed ${snapshot.chapterLinkCount.toLocaleString()} chapter links on this page`
      await publish()
      if (await stopped()) break

      let decision: NavigationDecision
      let reused = false
      const repeated = recipe
        ? snapshot.controls.find(
            (control) =>
              control.label === recipe!.label &&
              control.role === recipe!.role &&
              (!control.url || !run.pages.some((page) => page.url === publicPageUrl(control.url!))),
          )
        : undefined
      if (recipe && repeated) {
        decision = checkNavigationDecision(snapshot, {
          ...recipe.decision,
          controlId: repeated.id,
          value: recipe.value,
        })
        reused = true
      } else {
        recipe = undefined
        if (run.modelCalls >= NAVIGATION_LIMITS.decisions) {
          run.state = 'stopped'
          run.reason =
            'The three-decision budget is exhausted. Review the discovered path before continuing.'
          break
        }
        run.modelCalls++
        run.stage = 'Choosing the next browser action'
        await publish()
        const plan = await driver.decide(snapshot, run.activity)
        run.inputTokens += plan.inputTokens
        run.outputTokens += plan.outputTokens
        decision = checkNavigationDecision(snapshot, plan.decision)
      }
      if (await stopped()) break
      if (
        goal === 'samples' &&
        decision.pageType === 'chapter' &&
        !run.pages.some((page) => page.url === snapshot.url)
      ) {
        const page = await driver.capture()
        if (publicPageUrl(page.url) !== snapshot.url)
          throw new Error('The page changed during chapter capture.')
        if (
          run.pages.reduce((total, entry) => total + entry.html.length, page.html.length) >
          MAX_TOTAL_CAPTURE_CHARACTERS
        ) {
          run.state = 'stopped'
          run.reason = 'The rendered-sample text budget is full.'
          break
        }
        run.pages.push(page)
        if (run.pages.length >= NAVIGATION_LIMITS.samples) {
          run.state = 'completed'
          run.reason = 'Three rendered pages captured. Review them before testing the scraper.'
          break
        }
      }
      if (decision.action === 'finish' || decision.action === 'stop') {
        run.state = decision.action === 'finish' ? 'completed' : 'stopped'
        run.reason = decision.reason
        run.activity.push({
          step: run.actions,
          url: snapshot.url,
          action: decision.action,
          outcome: decision.reason,
          reused,
        })
        break
      }
      if (run.actions >= NAVIGATION_LIMITS.actions) {
        run.state = 'stopped'
        run.reason = 'The twelve-action browser budget is exhausted.'
        break
      }
      const control = snapshot.controls.find((entry) => entry.id === decision.controlId)
      run.stage = decision.reason
      await publish()
      await driver.act(snapshot, decision)
      run.actions++
      next = await driver.changed(snapshot)
      const changed = next.fingerprint !== snapshot.fingerprint
      run.activity.push({
        step: run.actions,
        url: snapshot.url,
        action: decision.intent,
        outcome: changed
          ? `Page changed; ${next.chapterLinkCount} chapter links observed.`
          : 'No content change detected.',
        reused,
      })
      if (!changed) {
        run.state = 'stopped'
        run.reason =
          'The last action did not change page content. Review the page instead of repeating it blindly.'
        break
      }
      if (
        decision.repeat &&
        control &&
        ['next_page', 'next_chapter', 'load_more'].includes(decision.intent)
      ) {
        recipe = { decision, label: control.label, role: control.role, value: decision.value }
        run.recipe = { intent: decision.intent, label: control.label, role: control.role }
      } else recipe = undefined
    }
  } catch (failure) {
    const cancelled = await driver.stopped()
    run.state = cancelled ? 'stopped' : 'failed'
    run.reason = cancelled
      ? 'Stopped by you. Completed captures are kept.'
      : failure instanceof Error
        ? failure.message
        : 'Browser exploration failed.'
  }
  run.stage = run.state === 'completed' ? 'Exploration complete' : 'Exploration stopped'
  await publish()
  return run
}
