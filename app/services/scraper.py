import os
import re
from typing import Any, Dict, List, Optional, Set, Tuple

from ..core import *  # noqa: F401,F403
from ..providers.pan115 import (
    create_115_folder,
    delete_115_entries,
    invalidate_115_entries_cache,
    list_115_entries_payload,
    move_115_entries,
    rename_115_entry,
)
from ..providers.quark import (
    create_quark_folder,
    delete_quark_entries,
    list_quark_entries_payload,
    move_quark_entries,
    rename_quark_entry,
)
from ..providers.tmdb import build_tmdb_task_binding, get_tmdb_media_detail, search_tmdb_media
from ..services.subscription_episode import _extract_task_episodes_from_file_entry
from ..subscription_scoring import parse_resource_episode_meta


SCRAPER_JOB_LIMIT_DEFAULT = 20
SCRAPER_SCAN_MAX_DIRS = 80
SCRAPER_SCAN_MAX_ENTRIES = 1200
SCRAPER_TAG_PATTERNS: Dict[str, List[Tuple[str, str]]] = {
    "resolution": [
        (r"\b(?:4320p|8k)\b", "8K"),
        (r"\b(?:2160p|4k|uhd)\b", "2160p"),
        (r"\b1080p\b", "1080p"),
        (r"\b720p\b", "720p"),
        (r"\b480p\b", "480p"),
    ],
    "source": [
        (r"\bremux\b", "REMUX"),
        (r"\b(?:blu[-_. ]?ray|bdrip|bdremux)\b", "BluRay"),
        (r"\bweb[-_. ]?dl\b", "WEB-DL"),
        (r"\bwebrip\b", "WEBRip"),
        (r"\bhdtv\b", "HDTV"),
    ],
    "dynamic_range": [
        (r"\bdolby[ ._-]?vision\b|\bdv\b", "DV"),
        (r"\bhdr10\+?\b", "HDR10"),
        (r"\bhdr\b", "HDR"),
    ],
    "video": [
        (r"\bhevc\b|\bh\.?265\b|\bx265\b", "HEVC"),
        (r"\bh\.?264\b|\bx264\b", "H.264"),
        (r"\bav1\b", "AV1"),
        (r"\b10[-_. ]?bit\b", "10bit"),
    ],
    "audio": [
        (r"\batmos\b", "Atmos"),
        (r"\btruehd\b", "TrueHD"),
        (r"\bdts[-_. ]?hd\b", "DTS-HD"),
        (r"\bdts\b", "DTS"),
        (r"\bddp\b|\bdd\+?\b", "DDP"),
        (r"\baac\b", "AAC"),
        (r"\bflac\b", "FLAC"),
    ],
}


def normalize_scraper_provider(value: Any) -> str:
    provider = str(value or "").strip().lower()
    if provider in ("115", "pan115", "115pan"):
        return "115"
    if provider in ("quark", "夸克"):
        return "quark"
    return ""


def get_scraper_provider_label(provider: str) -> str:
    return "夸克" if provider == "quark" else "115"


def _get_provider_cookie(provider: str, cfg: Optional[Dict[str, Any]] = None) -> str:
    active_cfg = cfg or get_config()
    return str(active_cfg.get("cookie_quark" if provider == "quark" else "cookie_115", "") or "").strip()


def build_scraper_providers_payload(cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    active_cfg = cfg or get_config()
    providers = []
    for provider in ("115", "quark"):
        cookie = _get_provider_cookie(provider, active_cfg)
        providers.append(
            {
                "provider": provider,
                "label": get_scraper_provider_label(provider),
                "configured": bool(cookie),
                "operations": {
                    "browse": True,
                    "create_folder": True,
                    "rename": True,
                    "move": True,
                    "delete": True,
                    "scrape": True,
                    "rollback": True,
                },
            }
        )
    return {"ok": True, "providers": providers}


def _require_provider_cookie(provider: str) -> str:
    normalized = normalize_scraper_provider(provider)
    if not normalized:
        raise RuntimeError("网盘类型无效")
    cookie = _get_provider_cookie(normalized)
    if not cookie:
        raise RuntimeError(f"请先配置 {get_scraper_provider_label(normalized)} Cookie")
    return cookie


def _list_provider_entries_payload(
    provider: str,
    cookie: str,
    cid: str = "0",
    *,
    force_refresh: bool = False,
    folders_only: bool = False,
) -> Dict[str, Any]:
    target_id = str(cid or "0").strip() or "0"
    if provider == "quark":
        return list_quark_entries_payload(cookie, target_id, folders_only=folders_only)
    return list_115_entries_payload(cookie, target_id, force_refresh=force_refresh, folders_only=folders_only)


def _create_provider_folder(provider: str, cookie: str, cid: str, name: str) -> Dict[str, Any]:
    if provider == "quark":
        return create_quark_folder(cookie, cid, name)
    return create_115_folder(cookie, cid, name)


def _rename_provider_entry(provider: str, cookie: str, entry_id: str, new_name: str, parent_id: str = "") -> Dict[str, Any]:
    if provider == "quark":
        return rename_quark_entry(cookie, entry_id, new_name, parent_id)
    return rename_115_entry(cookie, entry_id, new_name, parent_id)


def _move_provider_entries(provider: str, cookie: str, entry_ids: List[str], target_id: str, source_id: str = "") -> Dict[str, Any]:
    if provider == "quark":
        return move_quark_entries(cookie, entry_ids, target_id, source_id)
    return move_115_entries(cookie, entry_ids, target_id, source_id)


def _delete_provider_entries(provider: str, cookie: str, entry_ids: List[str], parent_id: str = "") -> Dict[str, Any]:
    if provider == "quark":
        return delete_quark_entries(cookie, entry_ids, parent_id)
    return delete_115_entries(cookie, entry_ids, parent_id)


def _invalidate_provider_parent(provider: str, parent_id: str = "") -> None:
    if provider == "115":
        invalidate_115_entries_cache(parent_id)


def _compact_scraper_entry(entry: Dict[str, Any], parent_id: str = "", parent_path: str = "") -> Dict[str, Any]:
    item = entry if isinstance(entry, dict) else {}
    is_dir = bool(item.get("is_dir"))
    entry_id = str(item.get("id", "") or "").strip()
    name = str(item.get("name", "") or "").strip()
    if not entry_id or not name:
        return {}
    effective_parent = str(item.get("parent_id", "") or parent_id or "0").strip() or "0"
    path = normalize_relative_path(join_relative_path(parent_path, name))
    payload: Dict[str, Any] = {
        "id": entry_id,
        "name": name,
        "is_dir": is_dir,
        "size": parse_int(item.get("size") or 0),
        "parent_id": effective_parent,
        "path": path,
        "modified_at": str(item.get("modified_at", "") or "").strip(),
    }
    if is_dir:
        payload["cid"] = str(item.get("cid", "") or entry_id).strip() or entry_id
    else:
        payload["fid"] = str(item.get("fid", "") or entry_id).strip() or entry_id
    return payload


def list_scraper_entries(provider: str, cid: str = "0", force_refresh: bool = False, search: str = "") -> Dict[str, Any]:
    normalized = normalize_scraper_provider(provider)
    cookie = _require_provider_cookie(normalized)
    target_id = str(cid or "0").strip() or "0"
    payload = _list_provider_entries_payload(normalized, cookie, target_id, force_refresh=force_refresh, folders_only=False)
    entries = [
        compact
        for compact in (_compact_scraper_entry(item, target_id) for item in (payload.get("entries", []) if isinstance(payload, dict) else []))
        if compact
    ]
    keyword = str(search or "").strip().lower()
    if keyword:
        entries = [item for item in entries if keyword in str(item.get("name", "")).lower()]
    summary = payload.get("summary", {}) if isinstance(payload, dict) and isinstance(payload.get("summary"), dict) else {}
    return {
        "ok": True,
        "provider": normalized,
        "cid": target_id,
        "entries": entries,
        "summary": {
            "folder_count": max(0, parse_int(summary.get("folder_count", 0), 0)),
            "file_count": max(0, parse_int(summary.get("file_count", 0), 0)),
        },
    }


def create_scraper_folder(provider: str, cid: str, name: str) -> Dict[str, Any]:
    normalized = normalize_scraper_provider(provider)
    cookie = _require_provider_cookie(normalized)
    parent_id = str(cid or "0").strip() or "0"
    folder = _create_provider_folder(normalized, cookie, parent_id, str(name or "").strip())
    _invalidate_provider_parent(normalized, parent_id)
    return {"ok": True, "provider": normalized, "cid": parent_id, "folder": folder}


def rename_scraper_entry(provider: str, entry_id: str, parent_id: str, name: str) -> Dict[str, Any]:
    normalized = normalize_scraper_provider(provider)
    cookie = _require_provider_cookie(normalized)
    result = _rename_provider_entry(normalized, cookie, entry_id, name, parent_id)
    _invalidate_provider_parent(normalized, parent_id)
    return {"ok": True, "provider": normalized, "entry": result}


def move_scraper_entries(provider: str, entry_ids: List[str], target_cid: str, source_cid: str = "") -> Dict[str, Any]:
    normalized = normalize_scraper_provider(provider)
    cookie = _require_provider_cookie(normalized)
    result = _move_provider_entries(normalized, cookie, entry_ids, target_cid, source_cid)
    _invalidate_provider_parent(normalized, source_cid)
    _invalidate_provider_parent(normalized, target_cid)
    return {"ok": True, "provider": normalized, "result": result}


def delete_scraper_entries(provider: str, entry_ids: List[str], parent_id: str = "") -> Dict[str, Any]:
    normalized = normalize_scraper_provider(provider)
    cookie = _require_provider_cookie(normalized)
    result = _delete_provider_entries(normalized, cookie, entry_ids, parent_id)
    _invalidate_provider_parent(normalized, parent_id)
    return {"ok": True, "provider": normalized, "result": result}


def _strip_extension(name: str) -> str:
    stem, _ = os.path.splitext(str(name or "").strip())
    return stem or str(name or "").strip()


def _is_scraper_excluded_archive(name: str) -> bool:
    return os.path.splitext(str(name or "").strip())[1].lower() in {".zip", ".rar"}


def _clean_search_title(value: str) -> str:
    text = _strip_extension(value)
    text = re.sub(r"[\[\(（【].{0,90}?(?:2160p|1080p|720p|4k|uhd|hdr|web[-_. ]?dl|bluray|remux|x26[45]|hevc|aac|dts|atmos|第.+?季|s\d{1,2}e\d{1,4}).{0,90}?[\]\)）】]", " ", text, flags=re.I)
    text = re.sub(r"\b(19|20)\d{2}\b", " ", text)
    text = re.sub(r"\bS\d{1,2}\s*E\d{1,4}\b|\bEP?\s*\d{1,4}\b|\bE\d{1,4}\b", " ", text, flags=re.I)
    text = re.sub(r"第\s*[零〇一二三四五六七八九十两兩0-9]{1,4}\s*(?:季|集|话|話)", " ", text)
    text = re.sub(r"(?:全|共)\s*\d{1,4}\s*(?:集|话|話)", " ", text)
    text = re.sub(r"[._\-]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip(" -_.")
    return text or _strip_extension(value)


def _extract_year_from_names(names: List[str]) -> str:
    for name in names:
        matched = re.search(r"\b(19|20)\d{2}\b", str(name or ""))
        if matched:
            return matched.group(0)
    return ""


def _looks_like_tv(names: List[str]) -> bool:
    text = " ".join(str(name or "") for name in names)
    if re.search(r"\bS\d{1,2}\s*E\d{1,4}\b|\bEP?\s*\d{1,4}\b", text, re.I):
        return True
    if re.search(r"第\s*[零〇一二三四五六七八九十两兩0-9]{1,4}\s*(?:季|集|话|話)|(?:全|共)\s*\d{1,4}\s*(?:集|话|話)|完结|完結", text):
        return True
    return False


def _build_task_from_tmdb(tmdb: Dict[str, Any], options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = tmdb if isinstance(tmdb, dict) else {}
    opts = options if isinstance(options, dict) else {}
    media_type = normalize_tmdb_media_type(payload.get("tmdb_media_type") or payload.get("media_type"), "movie")
    season = max(1, parse_int(opts.get("season") or payload.get("season") or 1, 1))
    episode_mode = normalize_tmdb_episode_mode(payload.get("tmdb_episode_mode") or payload.get("episode_mode") or "seasonal")
    return {
        "media_type": media_type,
        "season": season,
        "multi_season_mode": media_type == "tv" and episode_mode == "absolute",
        "anime_mode": media_type == "tv" and episode_mode == "absolute",
        "tmdb_id": max(0, parse_int(payload.get("tmdb_id") or payload.get("id") or 0, 0)),
        "tmdb_media_type": media_type,
        "tmdb_total_episodes": max(0, parse_int(payload.get("tmdb_total_episodes") or payload.get("total_episodes") or 0, 0)),
        "tmdb_total_seasons": max(0, parse_int(payload.get("tmdb_total_seasons") or payload.get("total_seasons") or 0, 0)),
        "tmdb_season_episode_map": normalize_tmdb_season_episode_map(payload.get("tmdb_season_episode_map") or payload.get("season_episode_map") or {}),
        "tmdb_episode_mode": episode_mode,
    }


def _score_tmdb_candidate(query: str, year: str, item: Dict[str, Any]) -> int:
    query_key = re.sub(r"\W+", "", str(query or "").lower())
    title_key = re.sub(r"\W+", "", str(item.get("title", "") or "").lower())
    original_key = re.sub(r"\W+", "", str(item.get("original_title", "") or "").lower())
    score = 35
    if query_key and query_key in {title_key, original_key}:
        score += 35
    elif query_key and (query_key in title_key or title_key in query_key or query_key in original_key or original_key in query_key):
        score += 20
    if year and str(item.get("year", "")) == year:
        score += 20
    if float(item.get("popularity", 0) or 0) > 10:
        score += 5
    return min(100, score)


def identify_scraper_media(payload: Dict[str, Any]) -> Dict[str, Any]:
    provider = normalize_scraper_provider(payload.get("provider", "115")) or "115"
    selected = payload.get("entries", []) if isinstance(payload.get("entries"), list) else []
    names = [str(item.get("path") or item.get("name") or "").strip() for item in selected if isinstance(item, dict)]
    if not names:
        return {"ok": True, "provider": provider, "query": "", "media_type": "movie", "year": "", "items": [], "candidates": []}
    folder_names = [str(item.get("name", "") or "").strip() for item in selected if isinstance(item, dict) and item.get("is_dir")]
    seed_name = folder_names[0] if len(folder_names) == 1 else names[0]
    query = _clean_search_title(seed_name)
    media_type = "tv" if _looks_like_tv(names) else "movie"
    year = _extract_year_from_names(names)
    cfg = get_config()
    config_error = validate_tmdb_runtime_config(cfg)
    if config_error:
        return {
            "ok": True,
            "provider": provider,
            "tmdb_configured": False,
            "msg": config_error,
            "query": query,
            "media_type": media_type,
            "year": year,
            "items": [],
            "candidates": [],
        }
    try:
        items = search_tmdb_media(query, media_type, year, cfg)
    except Exception as exc:
        return {
            "ok": True,
            "provider": provider,
            "tmdb_configured": True,
            "msg": str(exc),
            "query": query,
            "media_type": media_type,
            "year": year,
            "items": [],
            "candidates": [],
        }
    candidates = []
    for item in items:
        candidate = dict(item)
        candidate["confidence"] = _score_tmdb_candidate(query, year, candidate)
        candidates.append(candidate)
    binding = {}
    if candidates and int(candidates[0].get("confidence", 0) or 0) >= 72:
        try:
            detail = get_tmdb_media_detail(int(candidates[0].get("id", 0) or 0), str(candidates[0].get("media_type", media_type) or media_type), cfg)
            binding = build_tmdb_task_binding(detail, media_type=str(candidates[0].get("media_type", media_type) or media_type))
        except Exception:
            binding = {}
    return {
        "ok": True,
        "provider": provider,
        "tmdb_configured": True,
        "query": query,
        "media_type": media_type,
        "year": year,
        "items": candidates,
        "candidates": candidates,
        "binding": binding,
    }


def _selected_option_enabled(options: Any, key: str) -> bool:
    if isinstance(options, dict):
        return bool(options.get(key, False))
    if isinstance(options, list):
        return key in {str(item or "").strip() for item in options}
    return False


def extract_scraper_tags(name: str, preserve_options: Any) -> List[str]:
    tags: List[str] = []
    text = str(name or "")
    enabled_groups = {
        "resolution": _selected_option_enabled(preserve_options, "resolution"),
        "source": _selected_option_enabled(preserve_options, "source"),
        "dynamic_range": _selected_option_enabled(preserve_options, "dynamic_range"),
        "video": _selected_option_enabled(preserve_options, "video"),
        "audio": _selected_option_enabled(preserve_options, "audio"),
    }
    seen: Set[str] = set()
    for group, patterns in SCRAPER_TAG_PATTERNS.items():
        if not enabled_groups.get(group):
            continue
        for pattern, label in patterns:
            if re.search(pattern, text, re.I) and label not in seen:
                seen.add(label)
                tags.append(label)
    return tags


def sanitize_scraper_name(value: str, fallback: str = "Untitled") -> str:
    text = re.sub(r"[\\/:*?\"<>|]+", " ", str(value or "")).strip()
    text = re.sub(r"\s+", " ", text).strip(" .")
    return (text or fallback)[:180]


def _contains_cjk(value: str) -> bool:
    return bool(re.search(r"[\u4e00-\u9fff]", str(value or "")))


def choose_scraper_title(tmdb: Dict[str, Any], language: str = "zh", fallback: str = "") -> str:
    payload = tmdb if isinstance(tmdb, dict) else {}
    normalized_language = str(language or "zh").strip().lower()
    if normalized_language in ("", "auto", "default", "config"):
        cfg_language = str((get_config() or {}).get("tmdb_language", "zh-CN") or "zh-CN").strip().lower()
        normalized_language = "en" if cfg_language.startswith("en") else "zh"
    localized = str(payload.get("tmdb_localized_title") or payload.get("tmdb_title") or payload.get("title") or "").strip()
    english = str(payload.get("tmdb_english_title") or "").strip()
    original = str(payload.get("tmdb_original_title") or payload.get("original_title") or "").strip()
    aliases = payload.get("tmdb_aliases") or payload.get("aliases") or []
    alias_values = [str(item or "").strip() for item in aliases if str(item or "").strip()] if isinstance(aliases, list) else []
    if normalized_language in ("en", "english"):
        return sanitize_scraper_name(english or (original if original and not _contains_cjk(original) else "") or localized or fallback)
    if localized and _contains_cjk(localized):
        return sanitize_scraper_name(localized)
    cjk_alias = next((item for item in alias_values if _contains_cjk(item)), "")
    return sanitize_scraper_name(cjk_alias or localized or fallback)


def _build_tag_suffix(tags: List[str]) -> str:
    cleaned = [sanitize_scraper_name(tag, "") for tag in tags if sanitize_scraper_name(tag, "")]
    return f" [{' '.join(cleaned)}]" if cleaned else ""


def _format_tv_episode_code(task: Dict[str, Any], episodes: Set[int], default_season: int) -> Tuple[str, str]:
    normalized_values = sorted({max(0, int(value or 0)) for value in episodes if max(0, int(value or 0)) > 0})
    if not normalized_values:
        return "", "无法识别集数"
    season_map = normalize_tmdb_season_episode_map(task.get("tmdb_season_episode_map", {}))
    if is_subscription_multi_season_mode(task) and season_map:
        mapped = [convert_subscription_absolute_to_season_episode(task, value) for value in normalized_values]
        mapped = [(season, episode) for season, episode in mapped if season > 0 and episode > 0]
        if not mapped:
            return "", "连续编号无法映射到 TMDB 季集"
        seasons = {season for season, _ in mapped}
        if len(seasons) > 1:
            return "", "单个文件跨季，暂不自动命名"
        season_no = next(iter(seasons))
        episode_values = sorted({episode for _, episode in mapped})
    else:
        season_no = max(1, int(default_season or task.get("season", 1) or 1))
        episode_values = normalized_values
    if len(episode_values) == 1:
        return f"S{season_no:02d}E{episode_values[0]:02d}", ""
    return f"S{season_no:02d}E{episode_values[0]:02d}-E{episode_values[-1]:02d}", ""


def _build_scraper_target_path(entry: Dict[str, Any], tmdb: Dict[str, Any], options: Dict[str, Any]) -> Tuple[str, str]:
    media_type = normalize_tmdb_media_type(tmdb.get("tmdb_media_type") or tmdb.get("media_type"), "movie")
    language = str(options.get("title_language", "auto") or "auto")
    title = choose_scraper_title(tmdb, language, fallback=_clean_search_title(str(entry.get("name", "") or "")))
    year = normalize_tmdb_year(tmdb.get("tmdb_year") or tmdb.get("year") or "") or _extract_year_from_names([str(entry.get("name", "") or "")])
    year_suffix = f" ({year})" if year else ""
    _, ext = os.path.splitext(str(entry.get("name", "") or ""))
    tags = extract_scraper_tags(str(entry.get("name", "") or ""), options.get("preserve_tags", {}))
    tag_suffix = _build_tag_suffix(tags)
    base_title = sanitize_scraper_name(f"{title}{year_suffix}")
    if media_type == "tv":
        task = _build_task_from_tmdb(tmdb, options)
        episodes = _extract_task_episodes_from_file_entry(
            task,
            str(entry.get("path") or entry.get("name") or ""),
            parent_path=normalize_relative_path(str(entry.get("parent_path", "") or "")),
        )
        episode_code, issue = _format_tv_episode_code(task, episodes, max(1, parse_int(options.get("season") or task.get("season") or 1, 1)))
        if issue:
            return "", issue
        season_no = max(1, int(episode_code[1:3] or options.get("season") or 1))
        file_name = sanitize_scraper_name(f"{base_title} - {episode_code}{tag_suffix}") + ext
        return normalize_relative_path(join_relative_path(base_title, f"Season {season_no:02d}", file_name)), ""
    file_name = sanitize_scraper_name(f"{base_title}{tag_suffix}") + ext
    return normalize_relative_path(join_relative_path(base_title, file_name)), ""


def _walk_existing_folder(provider: str, cookie: str, base_cid: str, folder_path: str) -> Tuple[str, bool]:
    current = str(base_cid or "0").strip() or "0"
    parts = [part for part in normalize_relative_path(folder_path).split("/") if part]
    for part in parts:
        payload = _list_provider_entries_payload(provider, cookie, current, folders_only=True)
        entries = payload.get("entries", []) if isinstance(payload, dict) and isinstance(payload.get("entries"), list) else []
        matched = next((item for item in entries if item.get("is_dir") and str(item.get("name", "") or "").strip() == part), None)
        if not matched:
            return "", False
        current = str(matched.get("id") or matched.get("cid") or "").strip() or "0"
    return current, True


def _ensure_folder_from_base(provider: str, cookie: str, base_cid: str, folder_path: str) -> str:
    current = str(base_cid or "0").strip() or "0"
    for part in [part for part in normalize_relative_path(folder_path).split("/") if part]:
        payload = _list_provider_entries_payload(provider, cookie, current, folders_only=True)
        entries = payload.get("entries", []) if isinstance(payload, dict) and isinstance(payload.get("entries"), list) else []
        matched = next((item for item in entries if item.get("is_dir") and str(item.get("name", "") or "").strip() == part), None)
        if matched:
            current = str(matched.get("id") or matched.get("cid") or "").strip() or current
            continue
        created = _create_provider_folder(provider, cookie, current, part)
        current = str(created.get("id", "") or "").strip() or current
    return current


def _target_name_exists(provider: str, cookie: str, parent_id: str, target_name: str, same_entry_id: str = "") -> bool:
    if not parent_id:
        return False
    payload = _list_provider_entries_payload(provider, cookie, parent_id, folders_only=False)
    entries = payload.get("entries", []) if isinstance(payload, dict) and isinstance(payload.get("entries"), list) else []
    for item in entries:
        if str(item.get("name", "") or "").strip() != target_name:
            continue
        if same_entry_id and str(item.get("id", "") or "").strip() == same_entry_id:
            continue
        return True
    return False


def _expand_selected_scraper_entries(provider: str, cookie: str, selected: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[str]]:
    files: List[Dict[str, Any]] = []
    issues: List[str] = []
    dirs_seen = 0
    for raw in selected:
        item = raw if isinstance(raw, dict) else {}
        entry = _compact_scraper_entry(item, str(item.get("parent_id", "") or "0"), normalize_relative_path(str(item.get("parent_path", "") or "")))
        if not entry:
            continue
        if not entry.get("is_dir"):
            if _is_scraper_excluded_archive(str(entry.get("name", "") or "")):
                continue
            files.append(entry)
            continue
        queue: List[Tuple[str, str, int]] = [(str(entry.get("id", "") or entry.get("cid", "") or "0"), normalize_relative_path(str(entry.get("path", "") or entry.get("name", ""))), 0)]
        while queue and len(files) < SCRAPER_SCAN_MAX_ENTRIES and dirs_seen < SCRAPER_SCAN_MAX_DIRS:
            dir_id, dir_path, depth = queue.pop(0)
            dirs_seen += 1
            try:
                payload = _list_provider_entries_payload(provider, cookie, dir_id, folders_only=False)
            except Exception as exc:
                issues.append(f"读取目录 {dir_path or dir_id} 失败：{exc}")
                continue
            for child in payload.get("entries", []) if isinstance(payload, dict) else []:
                child_entry = _compact_scraper_entry(child, dir_id, dir_path)
                if not child_entry:
                    continue
                if child_entry.get("is_dir"):
                    if depth < 6:
                        queue.append((str(child_entry.get("id") or child_entry.get("cid") or "0"), normalize_relative_path(str(child_entry.get("path", ""))), depth + 1))
                else:
                    if _is_scraper_excluded_archive(str(child_entry.get("name", "") or "")):
                        continue
                    child_entry["parent_path"] = dir_path
                    files.append(child_entry)
                    if len(files) >= SCRAPER_SCAN_MAX_ENTRIES:
                        issues.append(f"已达到首版扫描上限 {SCRAPER_SCAN_MAX_ENTRIES} 个文件，超出部分未纳入计划")
                        break
    return files, issues


def build_scraper_rename_plan(payload: Dict[str, Any]) -> Dict[str, Any]:
    provider = normalize_scraper_provider(payload.get("provider", "115")) or "115"
    cookie = _require_provider_cookie(provider)
    tmdb = payload.get("tmdb") if isinstance(payload.get("tmdb"), dict) else {}
    if max(0, parse_int(tmdb.get("tmdb_id") or tmdb.get("id") or 0, 0)) <= 0:
        raise RuntimeError("请先选择 TMDB 条目")
    options = payload.get("options") if isinstance(payload.get("options"), dict) else {}
    base_cid = str(payload.get("base_cid", "0") or "0").strip() or "0"
    selected = payload.get("entries", []) if isinstance(payload.get("entries"), list) else []
    expanded_files, scan_issues = _expand_selected_scraper_entries(provider, cookie, selected)
    actions: List[Dict[str, Any]] = []
    issues: List[str] = list(scan_issues)
    target_paths: Set[str] = set()
    for index, entry in enumerate(expanded_files):
        target_path, issue = _build_scraper_target_path(entry, tmdb, options)
        old_parent_id = str(entry.get("parent_id", "") or base_cid).strip() or "0"
        old_path = normalize_relative_path(str(entry.get("path", "") or entry.get("name", "")))
        action_issue = issue
        target_parent_path = normalize_relative_path(os.path.dirname(target_path).replace("\\", "/")) if target_path else ""
        new_name = os.path.basename(target_path) if target_path else ""
        existing_parent_id = ""
        if target_path:
            if target_path in target_paths:
                action_issue = action_issue or "本批次内目标路径重复"
            target_paths.add(target_path)
            existing_parent_id, exists = _walk_existing_folder(provider, cookie, base_cid, target_parent_path)
            if exists and _target_name_exists(provider, cookie, existing_parent_id, new_name, same_entry_id=str(entry.get("id", "") or "")):
                action_issue = action_issue or "目标目录中已有同名文件"
        action = {
            "action_index": index + 1,
            "entry_id": str(entry.get("id", "") or ""),
            "is_dir": False,
            "old_parent_id": old_parent_id,
            "old_name": str(entry.get("name", "") or ""),
            "old_path": old_path,
            "new_parent_id": existing_parent_id,
            "new_name": new_name,
            "new_path": target_path,
            "target_parent_path": target_parent_path,
            "issue": action_issue,
            "ready": bool(target_path and not action_issue),
        }
        if action_issue:
            issues.append(f"{entry.get('name', '--')}：{action_issue}")
        actions.append(action)
    ready_count = sum(1 for item in actions if item.get("ready"))
    return {
        "ok": True,
        "provider": provider,
        "base_cid": base_cid,
        "actions": actions,
        "issues": issues,
        "ready": bool(actions) and ready_count == len(actions) and not issues,
        "ready_count": ready_count,
        "total_count": len(actions),
        "tmdb": tmdb,
        "options": options,
    }


def _insert_scraper_job(provider: str, plan: Dict[str, Any], options: Dict[str, Any], tmdb: Dict[str, Any]) -> int:
    ensure_db()
    now = now_text()
    actions = [item for item in plan.get("actions", []) if isinstance(item, dict)]
    conn = open_db()
    cursor = conn.cursor()
    cursor.execute(
        """
        INSERT INTO scraper_jobs(
            provider, status, status_detail, total_actions, created_at, updated_at,
            options_json, tmdb_json, plan_json
        ) VALUES (?, 'pending', '等待执行', ?, ?, ?, ?, ?, ?)
        """,
        (
            provider,
            len(actions),
            now,
            now,
            safe_json_dumps(options),
            safe_json_dumps(tmdb),
            safe_json_dumps({"base_cid": plan.get("base_cid", "0"), "actions": actions}),
        ),
    )
    job_id = int(cursor.lastrowid or 0)
    for action in actions:
        cursor.execute(
            """
            INSERT INTO scraper_job_actions(
                job_id, action_index, provider, entry_id, is_dir, old_parent_id, old_name, old_path,
                new_parent_id, new_name, new_path, target_parent_path, status, status_detail,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?)
            """,
            (
                job_id,
                max(0, parse_int(action.get("action_index"), 0)),
                provider,
                str(action.get("entry_id", "") or ""),
                1 if action.get("is_dir") else 0,
                str(action.get("old_parent_id", "") or "0"),
                str(action.get("old_name", "") or ""),
                str(action.get("old_path", "") or ""),
                str(action.get("new_parent_id", "") or ""),
                str(action.get("new_name", "") or ""),
                str(action.get("new_path", "") or ""),
                str(action.get("target_parent_path", "") or ""),
                now,
                now,
            ),
        )
    conn.commit()
    conn.close()
    return job_id


def create_scraper_job_from_plan(payload: Dict[str, Any]) -> Dict[str, Any]:
    plan = payload.get("plan") if isinstance(payload.get("plan"), dict) else {}
    provider = normalize_scraper_provider(plan.get("provider") or payload.get("provider", "115")) or "115"
    actions = [item for item in plan.get("actions", []) if isinstance(item, dict)]
    if not actions:
        raise RuntimeError("没有可执行的改名计划")
    blocked = [item for item in actions if item.get("issue") or not item.get("ready")]
    if blocked:
        raise RuntimeError("改名计划仍存在冲突或未识别项，请先处理后再执行")
    options = plan.get("options") if isinstance(plan.get("options"), dict) else {}
    tmdb = plan.get("tmdb") if isinstance(plan.get("tmdb"), dict) else {}
    job_id = _insert_scraper_job(provider, plan, options, tmdb)
    return {"ok": True, "job_id": job_id}


def _serialize_scraper_action_row(row: Any) -> Dict[str, Any]:
    item = sqlite_row_to_dict(row)
    if not item:
        return {}
    return {
        "id": int(item.get("id", 0) or 0),
        "job_id": int(item.get("job_id", 0) or 0),
        "action_index": int(item.get("action_index", 0) or 0),
        "provider": str(item.get("provider", "") or ""),
        "entry_id": str(item.get("entry_id", "") or ""),
        "is_dir": bool(item.get("is_dir", 0)),
        "old_parent_id": str(item.get("old_parent_id", "") or ""),
        "old_name": str(item.get("old_name", "") or ""),
        "old_path": str(item.get("old_path", "") or ""),
        "new_parent_id": str(item.get("new_parent_id", "") or ""),
        "new_name": str(item.get("new_name", "") or ""),
        "new_path": str(item.get("new_path", "") or ""),
        "target_parent_path": str(item.get("target_parent_path", "") or ""),
        "status": str(item.get("status", "") or ""),
        "status_detail": str(item.get("status_detail", "") or ""),
        "rollback_status": str(item.get("rollback_status", "") or ""),
        "rollback_detail": str(item.get("rollback_detail", "") or ""),
        "updated_at": str(item.get("updated_at", "") or ""),
    }


def _serialize_scraper_job_row(row: Any, actions: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    item = sqlite_row_to_dict(row)
    if not item:
        return {}
    return {
        "id": int(item.get("id", 0) or 0),
        "provider": str(item.get("provider", "") or ""),
        "status": str(item.get("status", "") or ""),
        "status_detail": str(item.get("status_detail", "") or ""),
        "total_actions": int(item.get("total_actions", 0) or 0),
        "succeeded_actions": int(item.get("succeeded_actions", 0) or 0),
        "failed_actions": int(item.get("failed_actions", 0) or 0),
        "rollback_succeeded_actions": int(item.get("rollback_succeeded_actions", 0) or 0),
        "rollback_failed_actions": int(item.get("rollback_failed_actions", 0) or 0),
        "created_at": str(item.get("created_at", "") or ""),
        "updated_at": str(item.get("updated_at", "") or ""),
        "started_at": str(item.get("started_at", "") or ""),
        "finished_at": str(item.get("finished_at", "") or ""),
        "options": safe_json_loads(item.get("options_json", "{}"), {}),
        "tmdb": safe_json_loads(item.get("tmdb_json", "{}"), {}),
        "can_rollback": int(item.get("succeeded_actions", 0) or 0) > 0 and str(item.get("status", "") or "") in {"completed", "partial", "rollback_failed"},
        "actions": actions or [],
    }


def get_scraper_jobs_state(limit: int = SCRAPER_JOB_LIMIT_DEFAULT, job_id: int = 0) -> Dict[str, Any]:
    ensure_db()
    conn = open_db()
    cursor = conn.cursor()
    if job_id > 0:
        cursor.execute("SELECT * FROM scraper_jobs WHERE id = ?", (int(job_id),))
        rows = cursor.fetchall()
    else:
        cursor.execute(
            "SELECT * FROM scraper_jobs ORDER BY id DESC LIMIT ?",
            (max(1, min(100, int(limit or SCRAPER_JOB_LIMIT_DEFAULT))),),
        )
        rows = cursor.fetchall()
    jobs: List[Dict[str, Any]] = []
    for row in rows:
        row_id = int(row["id"] or 0)
        cursor.execute("SELECT * FROM scraper_job_actions WHERE job_id = ? ORDER BY action_index ASC", (row_id,))
        actions = [_serialize_scraper_action_row(action_row) for action_row in cursor.fetchall()]
        jobs.append(_serialize_scraper_job_row(row, actions))
    conn.close()
    return {"ok": True, "jobs": jobs}


def _load_scraper_job(job_id: int) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    ensure_db()
    conn = open_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM scraper_jobs WHERE id = ?", (int(job_id),))
    job = sqlite_row_to_dict(cursor.fetchone())
    if not job:
        conn.close()
        raise RuntimeError("刮削任务不存在")
    cursor.execute("SELECT * FROM scraper_job_actions WHERE job_id = ? ORDER BY action_index ASC", (int(job_id),))
    actions = [sqlite_row_to_dict(row) for row in cursor.fetchall()]
    conn.close()
    return job, actions


def _update_scraper_job(job_id: int, **fields: Any) -> None:
    if not fields:
        return
    ensure_db()
    allowed = {
        "status",
        "status_detail",
        "succeeded_actions",
        "failed_actions",
        "rollback_succeeded_actions",
        "rollback_failed_actions",
        "started_at",
        "finished_at",
    }
    payload = {key: value for key, value in fields.items() if key in allowed}
    if not payload:
        return
    payload["updated_at"] = now_text()
    sets = ", ".join(f"{key} = ?" for key in payload.keys())
    values = list(payload.values()) + [int(job_id)]
    conn = open_db()
    conn.execute(f"UPDATE scraper_jobs SET {sets} WHERE id = ?", values)
    conn.commit()
    conn.close()


def _update_scraper_action(action_id: int, **fields: Any) -> None:
    if not fields:
        return
    allowed = {"new_parent_id", "status", "status_detail", "rollback_status", "rollback_detail", "response_json"}
    payload = {key: value for key, value in fields.items() if key in allowed}
    if not payload:
        return
    payload["updated_at"] = now_text()
    sets = ", ".join(f"{key} = ?" for key in payload.keys())
    values = list(payload.values()) + [int(action_id)]
    conn = open_db()
    conn.execute(f"UPDATE scraper_job_actions SET {sets} WHERE id = ?", values)
    conn.commit()
    conn.close()


def _build_temp_name(action_id: int, entry_id: str, original_name: str) -> str:
    _, ext = os.path.splitext(str(original_name or ""))
    token = re.sub(r"[^A-Za-z0-9]+", "", str(entry_id or ""))[:12] or str(action_id)
    return f".mediahub-tmp-{int(action_id)}-{token}{ext}"


def _execute_move_rename(
    provider: str,
    cookie: str,
    action: Dict[str, Any],
    target_parent_id: str,
    *,
    reverse: bool = False,
) -> Dict[str, Any]:
    entry_id = str(action.get("entry_id", "") or "").strip()
    if not entry_id:
        raise RuntimeError("文件 ID 不能为空")
    if reverse:
        source_parent = str(action.get("new_parent_id", "") or "").strip() or "0"
        source_name = str(action.get("new_name", "") or "")
        target_parent = str(action.get("old_parent_id", "") or "0").strip() or "0"
        target_name = str(action.get("old_name", "") or "")
    else:
        source_parent = str(action.get("old_parent_id", "") or "0").strip() or "0"
        source_name = str(action.get("old_name", "") or "")
        target_parent = target_parent_id
        target_name = str(action.get("new_name", "") or "")
    if not target_name:
        raise RuntimeError("目标文件名为空")
    if _target_name_exists(provider, cookie, target_parent, target_name, same_entry_id=entry_id):
        raise RuntimeError("目标目录中已有同名文件")
    need_move = source_parent != target_parent
    need_rename = source_name != target_name
    responses: List[Dict[str, Any]] = []
    if not need_move and not need_rename:
        return {"skipped": True, "detail": "文件名和目录未变化"}
    if need_move and need_rename:
        temp_name = _build_temp_name(int(action.get("id", 0) or 0), entry_id, source_name)
        responses.append(_rename_provider_entry(provider, cookie, entry_id, temp_name, source_parent))
        responses.append(_move_provider_entries(provider, cookie, [entry_id], target_parent, source_parent))
        responses.append(_rename_provider_entry(provider, cookie, entry_id, target_name, target_parent))
    elif need_rename:
        responses.append(_rename_provider_entry(provider, cookie, entry_id, target_name, source_parent))
    elif need_move:
        responses.append(_move_provider_entries(provider, cookie, [entry_id], target_parent, source_parent))
    _invalidate_provider_parent(provider, source_parent)
    _invalidate_provider_parent(provider, target_parent)
    return {"skipped": False, "responses": responses, "target_parent_id": target_parent}


def run_scraper_job(job_id: int) -> None:
    try:
        job, actions = _load_scraper_job(job_id)
        provider = normalize_scraper_provider(job.get("provider", "115")) or "115"
        cookie = _require_provider_cookie(provider)
        plan = safe_json_loads(job.get("plan_json", "{}"), {})
        base_cid = str(plan.get("base_cid", "0") or "0").strip() or "0"
    except Exception as exc:
        _update_scraper_job(job_id, status="failed", status_detail=str(exc), failed_actions=1, finished_at=now_text())
        return
    _update_scraper_job(job_id, status="running", status_detail="正在执行刮削改名", started_at=now_text(), finished_at="")
    succeeded = 0
    failed = 0
    for action in actions:
        action_id = int(action.get("id", 0) or 0)
        _update_scraper_action(action_id, status="running", status_detail="正在处理")
        try:
            target_parent_path = str(action.get("target_parent_path", "") or "")
            target_parent_id = str(action.get("new_parent_id", "") or "").strip()
            if not target_parent_id:
                target_parent_id = _ensure_folder_from_base(provider, cookie, base_cid, target_parent_path)
                _update_scraper_action(action_id, new_parent_id=target_parent_id)
                action["new_parent_id"] = target_parent_id
            result = _execute_move_rename(provider, cookie, action, target_parent_id)
            status = "skipped" if result.get("skipped") else "completed"
            detail = str(result.get("detail") or "已完成")
            _update_scraper_action(action_id, status=status, status_detail=detail, response_json=safe_json_dumps(result))
            succeeded += 1
        except Exception as exc:
            failed += 1
            _update_scraper_action(action_id, status="failed", status_detail=str(exc))
    if failed > 0 and succeeded > 0:
        status = "partial"
        detail = f"部分完成：成功 {succeeded}，失败 {failed}"
    elif failed > 0:
        status = "failed"
        detail = f"执行失败：失败 {failed}"
    else:
        status = "completed"
        detail = f"执行完成：{succeeded} 项"
    _update_scraper_job(
        job_id,
        status=status,
        status_detail=detail,
        succeeded_actions=succeeded,
        failed_actions=failed,
        finished_at=now_text(),
    )


def rollback_scraper_job(job_id: int) -> None:
    try:
        job, actions = _load_scraper_job(job_id)
        provider = normalize_scraper_provider(job.get("provider", "115")) or "115"
        cookie = _require_provider_cookie(provider)
    except Exception as exc:
        _update_scraper_job(job_id, status="rollback_failed", status_detail=str(exc), rollback_failed_actions=1, finished_at=now_text())
        return
    successful_actions = [item for item in actions if str(item.get("status", "") or "") in {"completed", "skipped"}]
    _update_scraper_job(job_id, status="rollback_running", status_detail="正在回退刮削任务", finished_at="")
    succeeded = 0
    failed = 0
    for action in reversed(successful_actions):
        action_id = int(action.get("id", 0) or 0)
        try:
            if str(action.get("status", "") or "") == "skipped":
                _update_scraper_action(action_id, rollback_status="skipped", rollback_detail="原动作未产生变化")
                succeeded += 1
                continue
            result = _execute_move_rename(
                provider,
                cookie,
                action,
                str(action.get("old_parent_id", "") or "0"),
                reverse=True,
            )
            _update_scraper_action(action_id, rollback_status="completed", rollback_detail="已回退", response_json=safe_json_dumps(result))
            succeeded += 1
        except Exception as exc:
            failed += 1
            _update_scraper_action(action_id, rollback_status="failed", rollback_detail=str(exc))
    status = "rolled_back" if failed <= 0 else "rollback_failed"
    detail = f"回退完成：成功 {succeeded}" if failed <= 0 else f"回退部分失败：成功 {succeeded}，失败 {failed}"
    _update_scraper_job(
        job_id,
        status=status,
        status_detail=detail,
        rollback_succeeded_actions=succeeded,
        rollback_failed_actions=failed,
        finished_at=now_text(),
    )
