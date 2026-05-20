import asyncio

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..core import *  # noqa: F401,F403

router = APIRouter()


@router.get("/tmdb/search")
async def search_tmdb_endpoint(request: Request) -> Dict[str, Any]:
    cfg = get_config()
    config_error = validate_tmdb_runtime_config(cfg)
    if config_error:
        return JSONResponse(status_code=400, content={"ok": False, "msg": config_error})

    query = str(request.query_params.get("q", "") or "").strip()
    if not query:
        return {"ok": True, "items": [], "query": "", "media_type": "multi", "page": 1, "total_pages": 1}

    media_type = normalize_tmdb_media_type(request.query_params.get("media_type", ""), fallback="")
    year = normalize_tmdb_year(request.query_params.get("year", "") or "")
    page = max(1, parse_int(request.query_params.get("page", "1") or "1", 1))
    try:
        data = await asyncio.to_thread(search_tmdb_media, query, media_type, year, page, cfg)
    except Exception as exc:
        return JSONResponse(status_code=400, content={"ok": False, "msg": str(exc)})
    return {
        "ok": True,
        "items": data["items"],
        "query": query,
        "media_type": media_type or "multi",
        "year": year,
        "page": data["page"],
        "total_pages": data["total_pages"],
    }


@router.get("/tmdb/detail")
async def get_tmdb_detail_endpoint(request: Request) -> Dict[str, Any]:
    cfg = get_config()
    config_error = validate_tmdb_runtime_config(cfg)
    if config_error:
        return JSONResponse(status_code=400, content={"ok": False, "msg": config_error})

    tmdb_id = max(0, parse_int(request.query_params.get("tmdb_id", "0") or "0", 0))
    media_type = normalize_tmdb_media_type(request.query_params.get("media_type", ""), fallback="")
    if tmdb_id <= 0:
        return JSONResponse(status_code=400, content={"ok": False, "msg": "TMDB ID 无效"})
    if media_type not in ("movie", "tv"):
        return JSONResponse(status_code=400, content={"ok": False, "msg": "TMDB 类型仅支持 movie / tv"})

    try:
        detail = await asyncio.to_thread(get_tmdb_media_detail, tmdb_id, media_type, cfg)
    except Exception as exc:
        return JSONResponse(status_code=400, content={"ok": False, "msg": str(exc)})

    task_binding = build_tmdb_task_binding(detail, media_type=media_type)

    return {"ok": True, "detail": detail, "task_binding": task_binding}


@router.get("/tmdb/trending")
async def get_tmdb_trending_endpoint(request: Request) -> Dict[str, Any]:
    cfg = get_config()
    config_error = validate_tmdb_runtime_config(cfg)
    if config_error:
        return JSONResponse(status_code=400, content={"ok": False, "msg": config_error})

    media_type = normalize_tmdb_media_type(request.query_params.get("media_type", ""), fallback="all")
    if media_type not in ("all", "movie", "tv"):
        media_type = "all"
    time_window = str(request.query_params.get("time_window", "week") or "week").strip().lower()
    if time_window not in ("day", "week"):
        time_window = "week"
    page = max(1, parse_int(request.query_params.get("page", "1") or "1", 1))

    try:
        data = await asyncio.to_thread(get_tmdb_trending, media_type, time_window, page, cfg)
    except Exception as exc:
        return JSONResponse(status_code=400, content={"ok": False, "msg": str(exc)})
    return {
        "ok": True,
        "items": data["items"],
        "media_type": media_type,
        "time_window": time_window,
        "page": data["page"],
        "total_pages": data["total_pages"],
    }


@router.get("/tmdb/popular")
async def get_tmdb_popular_endpoint(request: Request) -> Dict[str, Any]:
    cfg = get_config()
    config_error = validate_tmdb_runtime_config(cfg)
    if config_error:
        return JSONResponse(status_code=400, content={"ok": False, "msg": config_error})

    media_type = normalize_tmdb_media_type(request.query_params.get("media_type", ""), fallback="movie")
    if media_type not in ("movie", "tv"):
        media_type = "movie"
    page = max(1, parse_int(request.query_params.get("page", "1") or "1", 1))

    try:
        data = await asyncio.to_thread(get_tmdb_popular, media_type, page, cfg)
    except Exception as exc:
        return JSONResponse(status_code=400, content={"ok": False, "msg": str(exc)})
    return {
        "ok": True,
        "items": data["items"],
        "media_type": media_type,
        "page": data["page"],
        "total_pages": data["total_pages"],
    }


@router.get("/tmdb/genres")
async def get_tmdb_genres_endpoint(request: Request) -> Dict[str, Any]:
    cfg = get_config()
    config_error = validate_tmdb_runtime_config(cfg)
    if config_error:
        return JSONResponse(status_code=400, content={"ok": False, "msg": config_error})

    media_type = normalize_tmdb_media_type(request.query_params.get("media_type", ""), fallback="movie")
    if media_type not in ("movie", "tv"):
        media_type = "movie"

    try:
        genres = await asyncio.to_thread(get_tmdb_genre_list, media_type, cfg)
    except Exception as exc:
        return JSONResponse(status_code=400, content={"ok": False, "msg": str(exc)})
    return {"ok": True, "genres": genres, "media_type": media_type}


@router.get("/tmdb/discover")
async def discover_tmdb_endpoint(request: Request) -> Dict[str, Any]:
    cfg = get_config()
    config_error = validate_tmdb_runtime_config(cfg)
    if config_error:
        return JSONResponse(status_code=400, content={"ok": False, "msg": config_error})

    media_type = normalize_tmdb_media_type(request.query_params.get("media_type", ""), fallback="movie")
    if media_type not in ("movie", "tv"):
        media_type = "movie"
    genres = str(request.query_params.get("genres", "") or "").strip()
    sort_by = str(request.query_params.get("sort_by", "popularity.desc") or "popularity.desc").strip()
    vote_average_gte = max(0, min(10, float(request.query_params.get("vote_average_gte", "0") or "0")))
    year = normalize_tmdb_year(request.query_params.get("year", "") or "")
    page = max(1, parse_int(request.query_params.get("page", "1") or "1", 1))

    # 新增筛选参数
    with_original_language = str(request.query_params.get("with_original_language", "") or "").strip()
    year_from = normalize_tmdb_year(request.query_params.get("year_from", "") or "")
    year_to = normalize_tmdb_year(request.query_params.get("year_to", "") or "")
    vote_count_gte = max(0, int(request.query_params.get("vote_count_gte", "0") or "0"))
    runtime_gte = max(0, int(request.query_params.get("runtime_gte", "0") or "0"))
    runtime_lte = max(0, int(request.query_params.get("runtime_lte", "0") or "0"))

    # 如果有日期范围，清空单一年份
    if year_from or year_to:
        year = ""

    try:
        data = await asyncio.to_thread(
            discover_tmdb_media, media_type, genres, sort_by, vote_average_gte, year, page, cfg,
            with_original_language, year_from, year_to, vote_count_gte, runtime_gte, runtime_lte
        )
    except Exception as exc:
        return JSONResponse(status_code=400, content={"ok": False, "msg": str(exc)})
    return {
        "ok": True,
        "items": data["items"],
        "media_type": media_type,
        "genres": genres,
        "sort_by": sort_by,
        "page": data["page"],
        "total_pages": data["total_pages"],
    }
