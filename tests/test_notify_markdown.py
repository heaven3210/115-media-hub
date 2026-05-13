import unittest

from app.services.notify import _build_subscription_success_markdown


class NotifyMarkdownTest(unittest.TestCase):
    def test_subscription_success_highlights_only_resource_title_and_new_episodes(self) -> None:
        content = _build_subscription_success_markdown(
            task={"media_type": "tv", "title": "测试任务", "provider": "115", "total_episodes": 12},
            item={"title": "命中标题 <特别篇>", "link_type": "115share", "source_name": "频道A"},
            savepath="电视剧/测试任务",
            job_id=123,
            successful_count=1,
            notify_episodes=[8, 9],
            next_episode=9,
        )

        self.assertIn('概览：新增 <font color="warning">E8、E9</font>（共 2 集）', content)
        self.assertIn('命中资源：<font color="info">命中标题 &lt;特别篇&gt;</font>', content)
        self.assertIn("当前进度：E9 / 12", content)
        self.assertIn("保存路径：`电视剧/测试任务`", content)
        self.assertEqual(content.count("<font color="), 2)


if __name__ == "__main__":
    unittest.main()
