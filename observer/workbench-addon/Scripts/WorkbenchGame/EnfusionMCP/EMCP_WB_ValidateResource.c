/**
 * EMCP_WB_ValidateResource.c - Validate a registered material or texture by
 * resource path without relying on the Resource Manager GUI's mutable
 * selection/index state.
 *
 * Called via NET API TCP protocol: APIFunc = "EMCP_WB_ValidateResource"
 */

class EMCP_WB_ValidateResourceRequest : JsonApiStruct
{
	string action;
	string path;

	void EMCP_WB_ValidateResourceRequest()
	{
		RegV("action");
		RegV("path");
	}
}

class EMCP_WB_ValidateResourceResponse : JsonApiStruct
{
	string status;
	string message;
	string action;
	string resourceName;
	string absolutePath;
	bool valid;
	bool clean;
	ref array<string> m_aReports;
	ref array<int> m_aSeverity;

	void EMCP_WB_ValidateResourceResponse()
	{
		RegV("status");
		RegV("message");
		RegV("action");
		RegV("resourceName");
		RegV("absolutePath");
		RegV("valid");
		RegV("clean");
		m_aReports = {};
		m_aSeverity = {};
	}

	override void OnPack()
	{
		// Always emit both arrays, including clean results, so callers cannot
		// mistake omitted data for an implicit successful validation.
		StartArray("reports");
		for (int i = 0; i < m_aReports.Count(); i++)
			ItemString(m_aReports[i]);
		EndArray();

		StartArray("severity");
		for (int j = 0; j < m_aSeverity.Count(); j++)
			ItemInteger(m_aSeverity[j]);
		EndArray();
	}
}

class EMCP_WB_ValidateResource : NetApiHandler
{
	//------------------------------------------------------------------------------------------------
	static void Error(EMCP_WB_ValidateResourceResponse resp, string message)
	{
		resp.status = "error";
		resp.message = message;
		resp.valid = false;
		resp.clean = false;
	}

	//------------------------------------------------------------------------------------------------
	static bool AppendMaterialReports(MaterialValidatorResponse checks, EMCP_WB_ValidateResourceResponse resp)
	{
		if (!checks || !checks.reports || !checks.severity || checks.reports.Count() != checks.severity.Count())
			return false;

		for (int i = 0; i < checks.reports.Count(); i++)
		{
			int severity = checks.severity[i];
			if (severity < 1 || severity > 3)
				return false;
			resp.m_aReports.Insert(checks.reports[i]);
			resp.m_aSeverity.Insert(severity);
		}
		return true;
	}

	//------------------------------------------------------------------------------------------------
	static bool AppendTextureReports(TextureValidatorResponse checks, EMCP_WB_ValidateResourceResponse resp)
	{
		if (!checks || !checks.reports || !checks.severity || checks.reports.Count() != checks.severity.Count())
			return false;

		for (int i = 0; i < checks.reports.Count(); i++)
		{
			int severity = checks.severity[i];
			if (severity < 1 || severity > 3)
				return false;
			resp.m_aReports.Insert(checks.reports[i]);
			resp.m_aSeverity.Insert(severity);
		}
		return true;
	}

	//------------------------------------------------------------------------------------------------
	static void Finalize(EMCP_WB_ValidateResourceResponse resp)
	{
		bool hasFatal = false;
		for (int i = 0; i < resp.m_aSeverity.Count(); i++)
		{
			if (resp.m_aSeverity[i] == 3)
			{
				hasFatal = true;
				break;
			}
		}
		resp.valid = !hasFatal;
		resp.clean = resp.m_aReports.Count() == 0;
		resp.status = "ok";
		resp.message = resp.action + " validation completed: " + resp.m_aReports.Count().ToString() + " report(s), no fatal findings";
		if (hasFatal)
			resp.message = resp.action + " validation completed: " + resp.m_aReports.Count().ToString() + " report(s), fatal findings present";
	}

	//------------------------------------------------------------------------------------------------
	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_ValidateResourceRequest();
	}

	//------------------------------------------------------------------------------------------------
	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_ValidateResourceRequest req = EMCP_WB_ValidateResourceRequest.Cast(request);
		EMCP_WB_ValidateResourceResponse resp = new EMCP_WB_ValidateResourceResponse();
		resp.action = req.action;

		if (req.path == "")
		{
			Error(resp, "path parameter required");
			return resp;
		}
		if (req.action != "material" && req.action != "texture")
		{
			Error(resp, "Unknown validation action: " + req.action + ". Valid actions: material, texture");
			return resp;
		}

		ResourceManager resourceManager = Workbench.GetModule(ResourceManager);
		if (!resourceManager)
		{
			Error(resp, "ResourceManager module not available");
			return resp;
		}
		string virtualPath = req.path;
		MetaFile metaFile = resourceManager.GetMetaFile(req.path);
		// Prefab material assignments conventionally hold a GUID-qualified
		// ResourceName, while ResourceManager metadata lookup accepts the
		// virtual path portion. Support both without guessing a filesystem path.
		if (!metaFile && req.path.IndexOf("{") == 0)
		{
			int guidEnd = req.path.IndexOf("}");
			if (guidEnd > 0 && guidEnd + 1 < req.path.Length())
			{
				virtualPath = req.path.Substring(guidEnd + 1, req.path.Length() - guidEnd - 1);
				metaFile = resourceManager.GetMetaFile(virtualPath);
			}
		}

		ResourceName resourceId = req.path;
		if (metaFile)
			resourceId = metaFile.GetResourceID();
		resp.resourceName = resourceId;
		resp.absolutePath = virtualPath;
		if (metaFile)
			resp.absolutePath = metaFile.GetSourceFilePath();
		string resourcePath = virtualPath;
		resourcePath.ToLower();

		if (req.action == "material")
		{
			if (!resourcePath.EndsWith(".emat"))
			{
				Error(resp, "Material validation requires an .emat resource: " + req.path);
				return resp;
			}

			Resource materialResource = Resource.Load(resourceId);
			if (!materialResource || !materialResource.IsValid())
			{
				Error(resp, "Resource.Load failed for material: " + resourceId);
				return resp;
			}
			BaseContainer material = materialResource.GetResource().ToBaseContainer();
			if (!material)
			{
				Error(resp, "Loaded material has no BaseContainer: " + resourceId);
				return resp;
			}

			// Match the official MaterialValidator's checks while avoiding its
			// GUI-populated global material index.
			MaterialValidatorResponse checks = new MaterialValidatorResponse();
			MaterialValidatorUtils validator = new MaterialValidatorUtils();
			validator.ValidateUVs(material, 0, 5, checks);
			validator.CheckDefaults(material, checks);
			validator.CheckExtremes(material, 5, 95, checks);
			validator.CheckDependencies(material, checks);
			validator.CheckTextures(material, checks);
			if (!AppendMaterialReports(checks, resp))
			{
				Error(resp, "Material validator returned malformed report data");
				return resp;
			}
		}
		else
		{
			if (!resourcePath.EndsWith(".edds"))
			{
				Error(resp, "Texture validation requires a registered .edds resource: " + req.path);
				return resp;
			}
			if (!metaFile)
			{
				Error(resp, "Resource metadata not found for texture: " + req.path);
				return resp;
			}
			if (resp.absolutePath == "" || !FileIO.FileExists(resp.absolutePath))
			{
				Error(resp, "Registered texture has no readable source file: " + resourceId);
				return resp;
			}
			// The native texture validator dereferences Configurations[0] without
			// guarding it. Refuse malformed metadata rather than risking a crash.
			BaseContainerList configurations = metaFile.GetObjectArray("Configurations");
			if (!configurations || configurations.Count() < 1)
			{
				Error(resp, "Texture metadata has no Configurations entry: " + resourceId);
				return resp;
			}

			TextureValidatorResponse checks = new TextureValidatorResponse();
			TextureValidator validator = new TextureValidator();
			validator.TextureImportSettings(resp.absolutePath, checks);
			if (!AppendTextureReports(checks, resp))
			{
				Error(resp, "Texture validator returned malformed report data");
				return resp;
			}
		}

		Finalize(resp);
		return resp;
	}
}
