import unittest
from unittest.mock import AsyncMock, patch

from app.core import (
    build_cookie_health_payload,
    normalize_subscription_task,
    validate_subscription_runtime_config,
)
from app.providers.registry import get_all_capabilities, get_or_none
from app.providers.quark import list_quark_share_entries_fast
from app.routes import resource as resource_routes
from app.routes.resource import _compact_resource_browser_entries
from app.services.scraper import build_scraper_providers_payload
from app.services.subscription import _filter_subscription_supported_items


class MultiProviderSubscriptionTest(unittest.TestCase):
    def test_provider_capabilities_split_subscription_and_strm(self):
        caps = {item["name"]: item for item in get_all_capabilities({})}

        for name in ("115", "quark", "tianyi", "123pan", "aliyun"):
            self.assertTrue(caps[name]["supports_subscription"])

        self.assertTrue(caps["115"]["supports_strm"])
        for name in ("quark", "tianyi", "123pan", "aliyun"):
            self.assertFalse(caps[name]["supports_strm"])

    def test_subscription_fixed_link_uses_current_provider_link_type(self):
        task = normalize_subscription_task(
            {
                "name": "演示剧",
                "provider": "aliyun",
                "media_type": "tv",
                "title": "演示剧",
                "savepath": "电视剧/演示剧",
                "share_link_url": "https://www.alipan.com/s/abc123",
                "fixed_link_channel_search": True,
            }
        )

        self.assertEqual(task["provider"], "aliyun")
        self.assertEqual(task["share_link_url"], "https://www.alipan.com/s/abc123")
        self.assertTrue(task["fixed_link_channel_search"])

        wrong_link_task = normalize_subscription_task(
            {
                **task,
                "provider": "tianyi",
                "share_link_url": "https://www.alipan.com/s/abc123",
            }
        )
        self.assertEqual(wrong_link_task["share_link_url"], "")
        self.assertFalse(wrong_link_task["fixed_link_channel_search"])

    def test_subscription_validation_is_registry_driven(self):
        task = normalize_subscription_task(
            {
                "name": "演示电影",
                "provider": "123pan",
                "media_type": "movie",
                "title": "演示电影",
                "savepath": "电影",
            }
        )
        enabled_cfg = {
            "provider_enabled": {"123pan": True},
            "123pan_username": "demo",
            "123pan_password": "secret",
        }
        self.assertIsNone(validate_subscription_runtime_config(enabled_cfg, task))

        disabled_cfg = {
            "provider_enabled": {"123pan": False},
            "123pan_username": "demo",
            "123pan_password": "secret",
        }
        self.assertIn("未启用", validate_subscription_runtime_config(disabled_cfg, task))

        missing_cookie_cfg = {"provider_enabled": {"123pan": True}}
        self.assertIn("认证信息", validate_subscription_runtime_config(missing_cookie_cfg, task))

    def test_subscription_candidate_filter_uses_provider_link_type(self):
        items = [
            {"link_url": "https://cloud.189.cn/t/abcdef", "link_type": "tianyi"},
            {"link_url": "https://115.com/s/abcdef", "link_type": "115share"},
        ]

        kept = _filter_subscription_supported_items(items, "tianyi")

        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["link_type"], "tianyi")

    def test_compact_entry_preserves_generic_share_shape(self):
        entries = _compact_resource_browser_entries(
            [
                {
                    "id": "file-1",
                    "name": "E01.mkv",
                    "is_dir": False,
                    "cid": "",
                    "fid": "file-1",
                    "parent_id": "folder-1",
                    "size": 123,
                }
            ],
            include_share_fields=True,
        )

        self.assertEqual(entries[0]["fid"], "file-1")
        self.assertEqual(entries[0]["parent_id"], "folder-1")

    def test_password_provider_configuration_does_not_fall_back_to_115_cookie(self):
        provider = get_or_none("123pan")

        self.assertIsNotNone(provider)
        self.assertFalse(provider.is_configured({"123pan_username": "demo"}))
        self.assertTrue(provider.is_configured({"123pan_username": "demo", "123pan_password": "secret"}))

        payload = build_cookie_health_payload({"cookie_115": "valid-looking-cookie"})
        self.assertFalse(payload["123pan"]["configured"])
        self.assertEqual(payload["123pan"]["state"], "missing")

    def test_scraper_provider_payload_does_not_login_password_provider(self):
        provider = get_or_none("123pan")

        self.assertIsNotNone(provider)
        cfg = {
            "provider_enabled": {"115": False, "quark": False, "123pan": True},
            "123pan_username": "demo",
            "123pan_password": "secret",
        }
        with patch.object(provider, "get_cookie", side_effect=AssertionError("should not login")):
            payload = build_scraper_providers_payload(cfg)

        self.assertTrue(payload["ok"])
        providers = {item["provider"]: item for item in payload["providers"]}
        self.assertTrue(providers["123pan"]["configured"])


class ResourceProviderLoadingTest(unittest.IsolatedAsyncioTestCase):
    async def test_generic_quark_share_route_uses_fast_share_reader_when_paged(self):
        provider = get_or_none("quark")
        mocked_runner = AsyncMock(return_value={"entries": [], "summary": {}, "elapsed_ms": 1})

        with patch.object(resource_routes, "run_resource_browse_io", mocked_runner):
            await resource_routes._list_resource_share_entries_with_provider(
                provider,
                "cookie=value",
                "https://pan.quark.cn/s/abcdef",
                "",
                "",
                "0",
                0,
                50,
                paged=True,
                folders_only=False,
            )

        args, kwargs = mocked_runner.call_args
        self.assertIs(args[0], list_quark_share_entries_fast)
        self.assertIs(kwargs["executor"], resource_routes.resource_quark_share_executor)
        self.assertTrue(kwargs["include_diagnostics"])


if __name__ == "__main__":
    unittest.main()
