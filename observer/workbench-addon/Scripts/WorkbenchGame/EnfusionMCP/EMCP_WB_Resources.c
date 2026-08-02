/**
 * EMCP_WB_Resources.c - Resource operations handler
 *
 * Actions: register, rebuild, getInfo, open, browse
 * Uses the ResourceManager Workbench module.
 * Called via NET API TCP protocol: APIFunc = "EMCP_WB_Resources"
 */

class EMCP_WB_ResourcesRequest : JsonApiStruct
{
	string action;
	string path;
	bool buildRuntime;

	void EMCP_WB_ResourcesRequest()
	{
		RegV("action");
		RegV("path");
		RegV("buildRuntime");
	}
}

class EMCP_WB_ResourceEntry
{
	string m_sName;
	string m_sPath;
	string m_sType;
}

class EMCP_WB_ResourcesResponse : JsonApiStruct
{
	string status;
	string message;
	string action;
	string path;
	string resourceName;
	string guid;
	string resourceClass;
	string sourcePath;
	string editor;
	int configurationCount;
	int entryCount;
	ref array<ref EMCP_WB_ResourceEntry> m_aEntries;

	void EMCP_WB_ResourcesResponse()
	{
		RegV("status");
		RegV("message");
		RegV("action");
		RegV("path");
		RegV("resourceName");
		RegV("guid");
		RegV("resourceClass");
		RegV("sourcePath");
		RegV("editor");
		RegV("configurationCount");
		RegV("entryCount");
		m_aEntries = {};
	}

	override void OnPack()
	{
		if (m_aEntries.Count() > 0)
		{
			StartArray("entries");
			for (int i = 0; i < m_aEntries.Count(); i++)
			{
				EMCP_WB_ResourceEntry e = m_aEntries[i];
				StartObject("");
				StoreString("name", e.m_sName);
				StoreString("path", e.m_sPath);
				StoreString("type", e.m_sType);
				EndObject();
			}
			EndArray();
		}
	}
}

class EMCP_WB_Resources : NetApiHandler
{
	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_ResourcesRequest();
	}

	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_ResourcesRequest req = EMCP_WB_ResourcesRequest.Cast(request);
		EMCP_WB_ResourcesResponse resp = new EMCP_WB_ResourcesResponse();
		resp.action = req.action;
		resp.path = req.path;

		if (req.path == "")
		{
			resp.status = "error";
			resp.message = "path parameter required";
			return resp;
		}

		ResourceManager resMgr = Workbench.GetModule(ResourceManager);
		if (!resMgr)
		{
			resp.status = "error";
			resp.message = "ResourceManager module not available";
			return resp;
		}

		if (req.action == "register")
		{
			bool result = resMgr.RegisterResourceFile(req.path, req.buildRuntime);
			if (result)
			{
				resp.status = "ok";
				resp.message = "Resource registered: " + req.path;
			}
			else
			{
				resp.status = "error";
				resp.message = "RegisterResourceFile returned false for: " + req.path;
			}
		}
		else if (req.action == "rebuild")
		{
			resMgr.RebuildResourceFile(req.path, "", false);
			resp.status = "ok";
			resp.message = "Rebuild initiated for: " + req.path;
		}
		else if (req.action == "getInfo" || req.action == "open")
		{
			// ResourceManager validates virtual project paths without assuming they
			// are directly addressable filesystem paths. Keep this preflight even
			// though Workbench.OpenResource also returns a success flag: native open
			// APIs can change editor context before discovering a bad logical path.
			MetaFile metaFile = resMgr.GetMetaFile(req.path);
			if (!metaFile)
			{
				resp.status = "error";
				resp.message = "Resource metadata not found for: " + req.path;
				return resp;
			}

			ResourceName registeredName = metaFile.GetResourceID();
			resp.resourceName = registeredName;
			resp.sourcePath = metaFile.GetSourceFilePath();
			int guidEnd = resp.resourceName.IndexOf("}");
			if (resp.resourceName.IndexOf("{") == 0 && guidEnd > 1)
				resp.guid = resp.resourceName.Substring(1, guidEnd - 1);

			BaseContainerList configurations = metaFile.GetObjectArray("Configurations");
			if (configurations)
			{
				resp.configurationCount = configurations.Count();
				if (resp.configurationCount > 0)
				{
					BaseContainer primaryConfiguration = configurations.Get(0);
					if (primaryConfiguration)
						resp.resourceClass = primaryConfiguration.GetClassName();
				}
			}
			if (resp.resourceClass == "PTCResourceClass")
				resp.editor = "ParticleEditor";

			if (req.action == "getInfo")
			{
				resp.status = "ok";
				resp.message = "Resolved registered resource metadata: " + req.path;
			}
			else
			{
				// Workbench.OpenResource owns resource-class routing. In particular, a
				// .ptc must be routed to ParticleEditor rather than offered to the
				// already-open ResourceManager or WorldEditor module.
				bool result = Workbench.OpenResource(req.path);
				if (result)
				{
					resp.status = "ok";
					resp.message = "Opened resource through Workbench routing: " + req.path;
				}
				else
				{
					resp.status = "error";
					resp.message = "Workbench.OpenResource returned false for: " + req.path;
				}
			}
		}
		else if (req.action == "browse")
		{
			// Workbench.SearchResources requires a WorkbenchSearchResourcesCallback subclass
			// whose exact callback method signature is not publicly documented.
			// Until the callback pattern is confirmed at runtime, return a helpful error.
			resp.status = "error";
			resp.message = "browse action not yet implemented: Workbench.SearchResources requires a WorkbenchSearchResourcesCallback subclass. Use wb_open_resource or project_browse instead.";
		}
		else
		{
			resp.status = "error";
			resp.message = "Unknown action: " + req.action + ". Valid: register, rebuild, getInfo, open, browse";
		}

		return resp;
	}
}
