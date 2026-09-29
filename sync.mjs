#!/usr/bin/env node
/**
 * Mod arşivi aynalayıcı — SADECE BÜYÜR, ASLA SİLMEZ.
 *
 * NE YAPAR
 *
 * Kaynak depodaki (RuneForge-Mod-Storage) dosya indeksini okur, bizim
 * manifestimizle karşılaştırır ve YALNIZCA yeni dosyaları kendi
 * depolarımıza kopyalar.
 *
 * Kaynaktan bir mod SİLİNİRSE bizden silinmez: manifeste
 * `gone_from_source` olarak işaretlenir, dosya yerinde kalır. Arşivin
 * bütün amacı bu — kaynak bir gün kapanırsa ya da bir yazar modunu
 * geri çekerse kütüphanemizde boşluk oluşmasın.
 *
 * NEDEN KLONLAMIYORUZ
 *
 * Kaynak 56 GB. GitHub Actions makinelerinde ne o kadar disk var ne de
 * zaman. Bunun yerine Git Data API kullanılıyor: dosya indirilir, blob
 * olarak yüklenir, bir çalıştırmadaki tüm blob'lar TEK ağaç ve TEK
 * commit'te toplanır. Depo hiç klonlanmaz.
 *
 * DEPO BÖLME
 *
 * GitHub depo başına 5 GB öneriyor (sert sınır değil ama büyüyünce
 * uyarı geliyor). Bu yüzden hedef depolar sırayla dolduruluyor: biri
 * REPO_LIMIT_GB'ı geçince sonraki kullanılıyor. Hangi dosyanın hangi
 * depoda olduğu manifestte yazıyor.
 *
 * PARÇALI ÇALIŞMA
 *
 * --max-files ve --max-bytes ile her çalıştırma sınırlanıyor. Haftalık
 * senkron için birkaç yüz MB yeterli. İlk doldurmada betiği bitene
 * kadar tekrar tekrar çalıştırmak gerekiyor (aşağıdaki döngüye bak) —
 * böylece tek bir dev işlem yerine kaldığı yerden devam eden küçük
 * adımlar oluyor.
 *
 * KULLANIM
 *
 *   GITHUB_TOKEN=... node sync.mjs --max-files 300 --max-bytes 800MB
 *   GITHUB_TOKEN=... node sync.mjs --dry-run
 *
 *   # ilk doldurma: bitene kadar tekrarla
 *   while GITHUB_TOKEN=... node sync.mjs --max-bytes 1GB; do sleep 5; done
 */

import { Buffer } from 'node:buffer'

// ── Ayarlar ──────────────────────────────────────────────────────────
const OWNER = process.env.MIRROR_OWNER || 'Spryzenweb'

/** Hedef depolar, sırayla doldurulur. Dolunca listeye yenisini ekle. */
const TARGET_REPOS = (process.env.MIRROR_REPOS || 'autrex-mods-1')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean)

/** Manifest ilk depoda durur; küçük bir JSON. */
const MANIFEST_REPO = TARGET_REPOS[0]
const MANIFEST_PATH = 'manifest.json'
const BRANCH = 'main'

const SOURCE_REPO = 'MelancholySlime/RuneForge-Mod-Storage'
const SOURCE_INDEX = `https://raw.githubusercontent.com/${SOURCE_REPO}/main/_runeforge_files.json`
const SOURCE_RAW = `https://raw.githubusercontent.com/${SOURCE_REPO}/main/`

/**
 * Kapak resimleri dosya indeksinde YOK; RuneForge API'sindeki
 * `thumbnailKey` alanından geliyor ve ayrı bir CDN'de duruyor.
 * Bu yüzden ayrı bir aşama olarak aynalanıyorlar.
 */
const SOURCE_API = 'https://runeforge.dev/api/mods'
const SOURCE_IMG = 'https://r2-images-prod.runeforge.dev/'
const IMAGE_DIR = 'images/'
/** API sayfa boyutu sabit 24; `limit` parametresi yok sayılıyor. */
const PAGE_SIZE = 24

/**
 * Depo başına hedef üst sınır.
 *
 * GitHub'ın SERT sınırı yalnızca dosya başına 100 MB. Depo boyutu için
 * 5 GB tavsiye ediliyor ve üstüne çıkınca dostane bir e-posta gelebiliyor,
 * ama yayınlanmış bir kesme noktası yok — kaynak depo 56 GB ile çalışıyor.
 *
 * 20 GB, tavsiyenin makul üstünde kalırken kaynağın tamamının (56 GB)
 * üç depoya sığmasını sağlıyor. Yine de yetmezse aşağıdaki otomatik
 * depo açma devreye giriyor.
 */
const REPO_LIMIT_GB = Number(process.env.MIRROR_REPO_LIMIT_GB || 20)

/** GitHub tek dosyada 100 MB'ı reddediyor. Payla birlikte 95 MB'ta kesiyoruz. */
const MAX_FILE_BYTES = 95 * 1024 * 1024

const API = 'https://api.github.com'
const TOKEN = process.env.GITHUB_TOKEN || ''

// ── Argümanlar ───────────────────────────────────────────────────────
const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const has = (name) => args.includes(`--${name}`)

const parseBytes = (v, fallback) => {
  if (!v) return fallback
  const m = String(v).match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i)
  if (!m) return fallback
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[(m[2] || 'B').toUpperCase()]
  return Math.floor(Number(m[1]) * mult)
}

const MAX_FILES = Number(flag('max-files', '400'))
const MAX_BYTES = parseBytes(flag('max-bytes'), 900 * 1024 * 1024)
const DRY_RUN = has('dry-run')

// ── Küçük yardımcılar ────────────────────────────────────────────────
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB'
const log = (...a) => console.log(...a)

async function gh(path, options = {}) {
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'autrex-mod-mirror',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(options.headers || {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub ${res.status} ${path}\n${body.slice(0, 300)}`)
  }
  return res.status === 204 ? null : res.json()
}

/** Ağ hataları geçici olabiliyor; birkaç kez dene. */
async function retry(fn, tries = 3, waitMs = 2000) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (i < tries - 1) await new Promise((r) => setTimeout(r, waitMs * (i + 1)))
    }
  }
  throw last
}

// ── Manifest ─────────────────────────────────────────────────────────
const emptyManifest = () => ({
  version: 1,
  source: SOURCE_REPO,
  updated_at: null,
  repo_bytes: {},   // depo adı → yaklaşık bayt
  files: {},        // kaynak yolu → kayıt
  images: {},       // thumbnailKey → kayıt
})

async function loadManifest() {
  const url = `https://raw.githubusercontent.com/${OWNER}/${MANIFEST_REPO}/${BRANCH}/${MANIFEST_PATH}`
  const res = await fetch(url, { headers: { 'User-Agent': 'autrex-mod-mirror' } })
  if (!res.ok) {
    log('manifest bulunamadı, sıfırdan başlanıyor')
    return emptyManifest()
  }
  try {
    const m = await res.json()
    return { ...emptyManifest(), ...m }
  } catch {
    log('manifest okunamadı, sıfırdan başlanıyor')
    return emptyManifest()
  }
}

/**
 * Sırada yeri olan ilk depo.
 *
 * Hepsi dolduysa sıradakini KENDİSİ AÇMAYA çalışır (autrex-mods-4, -5…).
 * Bu yalnızca depo açma yetkisi olan bir jetonla mümkün: Actions'ın kendi
 * GITHUB_TOKEN'i ne yeni depo açabiliyor ne de başka depoya yazabiliyor.
 * Jeton yoksa son depoya yazmaya devam edilir ve neden olduğu loglanır —
 * arşiv durmaz, sadece tek depoda büyür.
 */
async function pickRepo(manifest) {
  const limit = REPO_LIMIT_GB * 1024 ** 3

  for (const repo of TARGET_REPOS) {
    if ((manifest.repo_bytes[repo] || 0) < limit) return repo
  }

  // Hepsi dolu: sıradakini aç
  const next = nextRepoName(TARGET_REPOS.at(-1))
  if (!next) {
    log(`UYARI: depo adı türetilemedi, ${TARGET_REPOS.at(-1)} kullanılmaya devam ediyor`)
    return TARGET_REPOS.at(-1)
  }

  try {
    await gh(`/repos/${OWNER}/${next}`)
    log(`depolar doldu → ${next} zaten var, oraya geçiliyor`)
  } catch {
    log(`depolar doldu → ${next} açılıyor`)
    try {
      await gh('/user/repos', {
        method: 'POST',
        body: JSON.stringify({
          name: next,
          private: false,
          description: 'Autrex mod arşivi — sadece büyür, silinmez',
          auto_init: false,
        }),
      })
    } catch (e) {
      log(
        `yeni depo açılamadı (${e.message.split('\n')[0]}). ` +
          `Depo açma yetkisi olan bir jeton gerekiyor; ` +
          `${TARGET_REPOS.at(-1)} kullanılmaya devam ediyor.`,
      )
      return TARGET_REPOS.at(-1)
    }
  }

  TARGET_REPOS.push(next)
  manifest.repo_bytes[next] = manifest.repo_bytes[next] || 0
  return next
}

/** "autrex-mods-3" → "autrex-mods-4" */
function nextRepoName(name) {
  const m = String(name || '').match(/^(.*?)(\d+)$/)
  if (!m) return null
  return m[1] + (Number(m[2]) + 1)
}

// ── Git Data API ile toplu yazma ─────────────────────────────────────
/**
 * Bir depoya birden çok dosyayı TEK commit'te yazar.
 * entries: [{ path, contentBase64 }]
 */
/**
 * Bomboş bir depoya Git Data API ile blob yazılamıyor:
 * "Git Repository is empty" (409). Contents API ise boş depoda çalışıp
 * varsayılan dalı oluşturuyor. Bu yüzden ilk commit'i oradan atıyoruz.
 */
const initialized = new Set()
async function ensureRepoInitialized(repo) {
  if (initialized.has(repo)) return
  const base = `/repos/${OWNER}/${repo}`
  try {
    await gh(`${base}/git/ref/heads/${BRANCH}`)
    initialized.add(repo)
    return
  } catch {
    // dal yok, oluştur
  }

  const readme = [
    `# ${repo}`,
    '',
    'Autrex mod arşivi. Bu depo otomatik doldurulur.',
    '',
    'Kaynaktan kaldırılan içerik buradan **silinmez** — arşivin amacı bu.',
    'Dosya dizini: `manifest.json` (autrex-mods-1).',
    '',
    'Üreten: `tools/mod-mirror/sync.mjs`',
  ].join('\n')

  await gh(`${base}/contents/README.md`, {
    method: 'PUT',
    body: JSON.stringify({
      message: 'depo başlatıldı',
      content: Buffer.from(readme, 'utf8').toString('base64'),
      branch: BRANCH,
    }),
  })
  log(`  ${repo}: ilk commit atıldı`)
  initialized.add(repo)
}

/** Tek ağaçta kaç girdi olacağı. Büyük ağaçlarda GitHub 502 dönüyor. */
const TREE_CHUNK = 40

async function commitFiles(repo, entries, message) {
  if (!entries.length) return null
  await ensureRepoInitialized(repo)
  const base = `/repos/${OWNER}/${repo}`

  let lastSha = null

  // 265 girdilik tek ağaç denendi, GitHub 502 döndü. Parçalara bölüp
  // her parçayı kendi commit'inde işliyoruz; her parça bir öncekinin
  // üstüne biniyor, yani sonuç aynı ama istekler küçük kalıyor.
  for (let i = 0; i < entries.length; i += TREE_CHUNK) {
    const chunk = entries.slice(i, i + TREE_CHUNK)

    const tree = []
    for (const e of chunk) {
      const blob = await retry(() =>
        gh(`${base}/git/blobs`, {
          method: 'POST',
          body: JSON.stringify({ content: e.contentBase64, encoding: 'base64' }),
        }),
      )
      tree.push({ path: e.path, mode: '100644', type: 'blob', sha: blob.sha })
    }

    // Dal ucunu her parçada yeniden oku: bir önceki parça onu ilerletti.
    const ref = await retry(() => gh(`${base}/git/ref/heads/${BRANCH}`))
    const parent = ref.object.sha
    const parentCommit = await retry(() => gh(`${base}/git/commits/${parent}`))

    const newTree = await retry(() =>
      gh(`${base}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree }),
      }),
    )

    const commit = await retry(() =>
      gh(`${base}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({ message, tree: newTree.sha, parents: [parent] }),
      }),
    )

    await retry(() =>
      gh(`${base}/git/refs/heads/${BRANCH}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha }),
      }),
    )

    lastSha = commit.sha
    if (entries.length > TREE_CHUNK) {
      log(`    ${Math.min(i + TREE_CHUNK, entries.length)}/${entries.length}`)
    }
  }

  return lastSha
}

/**
 * API'yi sayfalayarak bütün kapak resmi anahtarlarını toplar.
 * Sayfa boyutu sabit 24; `limit` parametresi yok sayılıyor, `page` çalışıyor.
 */
async function fetchAllThumbnailKeys() {
  const keys = new Set()
  let page = 1
  let total = null

  while (true) {
    let data
    try {
      data = await retry(async () => {
        const r = await fetch(`${SOURCE_API}?page=${page}`, {
          headers: { 'User-Agent': 'autrex-mod-mirror' },
        })
        if (!r.ok) throw new Error(`api ${r.status}`)
        return r.json()
      }, 2, 1500)
    } catch (e) {
      /*
       * Son sayfanın ötesini isteyince API 500 "Requested range not
       * satisfiable" dönüyor — hata değil, liste bitti demek. `total`
       * sayfa boyutuna tam bölünmediği için hesapla durmak güvenilir
       * değil (129. sayfada 1 kayıt var, 130 patlıyor).
       */
      log(`  sayfa ${page} alınamadı (${e.message}), liste bitti sayılıyor`)
      break
    }

    const mods = Array.isArray(data.mods) ? data.mods : []
    if (total === null) total = Number(data.total || 0)
    if (!mods.length) break

    for (const m of mods) {
      const k = String(m.thumbnailKey || '').trim()
      if (k && !/^https?:\/\//i.test(k)) keys.add(k.replace(/^\/+/, ''))
    }

    if (mods.length < PAGE_SIZE) break
    page++
    if (page > 1000) break
  }
  return { keys: [...keys], total }
}

/** Kapak resimlerini aynala. Mod dosyalarından ayrı, kendi bütçesiyle. */
async function syncImages(manifest) {
  log('\n── kapak resimleri ──')
  const { keys, total } = await fetchAllThumbnailKeys()
  log(`API: ${total} mod | benzersiz kapak: ${keys.length} | arşivde: ${Object.keys(manifest.images).length}`)

  const missing = keys.filter((k) => !manifest.images[k])
  if (!missing.length) {
    log('kapak resimleri güncel.')
    return 0
  }
  log(`eksik: ${missing.length}`)
  if (DRY_RUN) return missing.length

  const repo = await pickRepo(manifest)
  const batch = []
  let bytes = 0

  for (const key of missing) {
    if (batch.length >= MAX_FILES || bytes >= MAX_BYTES) break
    const url = SOURCE_IMG + key.split('/').map(encodeURIComponent).join('/')
    let buf
    try {
      buf = await retry(async () => {
        const r = await fetch(url, { headers: { 'User-Agent': 'autrex-mod-mirror' } })
        if (!r.ok) throw new Error(`indirilemedi ${r.status}`)
        return Buffer.from(await r.arrayBuffer())
      }, 2, 1500)
    } catch (e) {
      log(`  atlandı: ${key} — ${e.message}`)
      continue
    }
    if (buf.length > MAX_FILE_BYTES) continue
    batch.push({ key, buffer: buf })
    bytes += buf.length
  }

  if (!batch.length) return missing.length

  log(`${batch.length} resim / ${mb(bytes)} yükleniyor → ${repo}`)
  await commitFiles(
    repo,
    batch.map((b) => ({ path: IMAGE_DIR + b.key, contentBase64: b.buffer.toString('base64') })),
    `arşiv: ${batch.length} yeni kapak resmi`,
  )

  const now = new Date().toISOString()
  for (const b of batch) {
    manifest.images[b.key] = {
      repo,
      size: b.buffer.length,
      first_seen: now,
      raw_url: `https://raw.githubusercontent.com/${OWNER}/${repo}/${BRANCH}/${IMAGE_DIR}${encodeURIComponent(b.key)}`,
      // Küçük dosyalar için jsDelivr gerçek bir CDN; hız sınırı derdi yok.
      cdn_url: `https://cdn.jsdelivr.net/gh/${OWNER}/${repo}@${BRANCH}/${IMAGE_DIR}${encodeURIComponent(b.key)}`,
    }
  }
  manifest.repo_bytes[repo] = (manifest.repo_bytes[repo] || 0) + bytes
  log(`kalan resim: ${missing.length - batch.length}`)
  return missing.length - batch.length
}

// ── Ana akış ─────────────────────────────────────────────────────────
async function main() {
  if (!TOKEN && !DRY_RUN) {
    console.error('GITHUB_TOKEN gerekli (depolara yazma yetkisi olan bir token).')
    process.exit(1)
  }

  log(`kaynak : ${SOURCE_REPO}`)
  log(`hedef  : ${OWNER}/{${TARGET_REPOS.join(', ')}}`)
  log(`sınır  : ${MAX_FILES} dosya / ${mb(MAX_BYTES)} bu çalıştırmada\n`)

  const srcRes = await fetch(SOURCE_INDEX, { headers: { 'User-Agent': 'autrex-mod-mirror' } })
  if (!srcRes.ok) throw new Error(`kaynak indeks okunamadı: ${srcRes.status}`)
  const srcIndex = await srcRes.json()
  const srcFiles = Array.isArray(srcIndex.files) ? srcIndex.files : []
  if (!srcFiles.length) throw new Error('kaynak indeks boş görünüyor, işlem durduruldu')

  const manifest = await loadManifest()
  const known = manifest.files

  /*
   * Resimler önce: toplamı birkaç yüz MB ve sitede en görünür şey onlar.
   * Kaynak düşerse bozuk mod dosyası sessizce fark edilir, bozuk kapak
   * grid'i anında göze batar.
   */
  if (!has('skip-images')) {
    try {
      await syncImages(manifest)
    } catch (e) {
      // Resim aşaması patlarsa dosya aşaması yine de çalışsın.
      log('resim aşaması hata verdi: ' + e.message)
    }
  }
  if (has('only-images')) {
    if (!DRY_RUN) await saveManifest(manifest)
    return
  }

  log('\n── mod dosyaları ──')

  // Kaynakta olmayanları işaretle — ama SİLME.
  const srcSet = new Set(srcFiles)
  let gone = 0
  for (const [path, rec] of Object.entries(known)) {
    if (!srcSet.has(path) && !rec.gone_from_source) {
      rec.gone_from_source = true
      rec.gone_seen_at = new Date().toISOString()
      gone++
    }
  }
  if (gone) log(`${gone} dosya kaynaktan kalkmış — arşivde bırakıldı\n`)

  const missing = srcFiles.filter((p) => !known[p])
  log(`kaynak: ${srcFiles.length} dosya | arşiv: ${Object.keys(known).length} | eksik: ${missing.length}\n`)

  if (!missing.length) {
    log('arşiv güncel.')
    if (gone && !DRY_RUN) await saveManifest(manifest)
    process.exit(2) // döngüyü bitirmek için: "yapacak yeni iş yok"
  }

  if (DRY_RUN) {
    log('kuru çalıştırma, ilk 10 eksik dosya:')
    missing.slice(0, 10).forEach((p) => log('  ' + p))
    return
  }

  const repo = await pickRepo(manifest)
  log(`bu turda hedef depo: ${repo}\n`)

  const batch = []
  let bytes = 0
  let skipped = 0

  for (const path of missing) {
    if (batch.length >= MAX_FILES || bytes >= MAX_BYTES) break

    const url = SOURCE_RAW + path.split('/').map(encodeURIComponent).join('/')
    let buf
    try {
      buf = await retry(async () => {
        const r = await fetch(url, { headers: { 'User-Agent': 'autrex-mod-mirror' } })
        if (!r.ok) throw new Error(`indirilemedi ${r.status}`)
        return Buffer.from(await r.arrayBuffer())
      })
    } catch (e) {
      log(`  atlandı (indirilemedi): ${path} — ${e.message}`)
      skipped++
      continue
    }

    if (buf.length > MAX_FILE_BYTES) {
      // GitHub 100 MB üstünü reddediyor. Kaydı manifeste "çok büyük" diye
      // yazıyoruz ki her turda tekrar indirmeye çalışmayalım.
      log(`  atlandı (çok büyük, ${mb(buf.length)}): ${path}`)
      known[path] = {
        size: buf.length,
        too_large: true,
        source_url: url,
        first_seen: new Date().toISOString(),
      }
      skipped++
      continue
    }

    batch.push({ path, buffer: buf })
    bytes += buf.length
    log(`  + ${mb(buf.length).padStart(9)}  ${path}`)
  }

  if (!batch.length) {
    log('\nbu turda yüklenecek dosya kalmadı.')
    await saveManifest(manifest)
    process.exit(skipped ? 0 : 2)
  }

  log(`\n${batch.length} dosya / ${mb(bytes)} yükleniyor → ${repo}`)

  const sha = await commitFiles(
    repo,
    batch.map((b) => ({ path: b.path, contentBase64: b.buffer.toString('base64') })),
    `arşiv: ${batch.length} yeni mod`,
  )
  log(`commit: ${sha?.slice(0, 8)}`)

  const now = new Date().toISOString()
  for (const b of batch) {
    known[b.path] = {
      repo,
      path: b.path,
      size: b.buffer.length,
      first_seen: now,
      gone_from_source: false,
      raw_url: `https://raw.githubusercontent.com/${OWNER}/${repo}/${BRANCH}/${b.path
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`,
    }
  }
  manifest.repo_bytes[repo] = (manifest.repo_bytes[repo] || 0) + bytes

  await saveManifest(manifest)
  log(`\nkalan: ${missing.length - batch.length - skipped} dosya`)
}

async function saveManifest(manifest) {
  manifest.updated_at = new Date().toISOString()
  const json = JSON.stringify(manifest, null, 1)
  await commitFiles(
    MANIFEST_REPO,
    [{ path: MANIFEST_PATH, contentBase64: Buffer.from(json, 'utf8').toString('base64') }],
    `manifest: ${Object.keys(manifest.files).length} kayıt`,
  )
  log(`manifest güncellendi (${Object.keys(manifest.files).length} kayıt)`)
}

main().catch((e) => {
  console.error('\nHATA:', e.message)
  process.exit(1)
})
