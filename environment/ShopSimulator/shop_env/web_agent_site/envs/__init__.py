from gym.envs.registration import register

register(
  id='WebAgentSiteEnv-v0',
  entry_point='web_agent_site.envs:WebAgentSiteEnv',
)


def __getattr__(name):
  if name == 'WebAgentTextEnv':
    from web_agent_site.envs.web_agent_text_env import WebAgentTextEnv
    return WebAgentTextEnv
  if name == 'WebAgentSiteEnv':
    from web_agent_site.envs.web_agent_site_env import WebAgentSiteEnv
    return WebAgentSiteEnv
  raise AttributeError(name)

register(
  id='WebAgentTextEnv-v0',
  entry_point='web_agent_site.envs:WebAgentTextEnv',
)
